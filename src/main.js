import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { Impit } from 'impit';

await Actor.init();

const PROPERTY_LISTING_QUERY = {
    operationName: 'PropertyListingQuery',
    hash: '82abb7da6738db4c904e4d10130072236a751b5a315f6dfaf92474793597bc33',
};

const EXPEDIA_HOST_PATTERN = /(^|\.)expedia\.[a-z.]+$/i;
const DEFAULT_STAY_OFFSET_DAYS = 30;
const DEFAULT_STAY_LENGTH_DAYS = 1;
const REQUEST_TIMEOUT_MS = 60000;
const BOOTSTRAP_RETRYABLE_STATUS_CODES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const BOOTSTRAP_RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
const BOOTSTRAP_BASE_BACKOFF_MS = 900;
const BOOTSTRAP_MAX_BACKOFF_MS = 4500;
const BOOTSTRAP_MAX_ATTEMPTS_WITHOUT_PROXY = 2;
const BOOTSTRAP_MAX_ATTEMPTS_WITH_PROXY = 3;

const GRAPHQL_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const GRAPHQL_RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'ENETUNREACH']);
const GRAPHQL_BASE_BACKOFF_MS = 1000;
const GRAPHQL_MAX_BACKOFF_MS = 10000;
const GRAPHQL_MAX_ATTEMPTS = 3;

const PAGE_REQUEST_DELAY_MIN_MS = 700;
const PAGE_REQUEST_DELAY_MAX_MS = 1800;

const impitClients = new Map();

function cleanText(value) {
    if (value === null || value === undefined) return undefined;
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text || undefined;
}

function compactObject(value) {
    if (Array.isArray(value)) {
        const cleaned = value
            .map((item) => compactObject(item))
            .filter((item) => item !== undefined);
        return cleaned.length ? cleaned : undefined;
    }

    if (value && typeof value === 'object') {
        const output = {};
        for (const [key, nestedValue] of Object.entries(value)) {
            const cleaned = compactObject(nestedValue);
            if (cleaned !== undefined) output[key] = cleaned;
        }
        return Object.keys(output).length ? output : undefined;
    }

    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
}

function toNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    const text = cleanText(value);
    if (!text) return undefined;

    const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return undefined;

    const number = Number(match[0]);
    return Number.isFinite(number) ? number : undefined;
}

function toInteger(value) {
    const number = toNumber(value);
    if (number === undefined) return undefined;
    return Math.trunc(number);
}

function unwrapEnclosingPairs(value) {
    let unwrapped = value;
    const pairs = [
        ['"', '"'],
        ["'", "'"],
        ['`', '`'],
        ['<', '>'],
        ['(', ')'],
        ['[', ']'],
        ['{', '}'],
    ];

    let changed = true;
    while (changed) {
        changed = false;
        for (const [opening, closing] of pairs) {
            if (unwrapped.startsWith(opening) && unwrapped.endsWith(closing)) {
                unwrapped = unwrapped.slice(1, -1).trim();
                changed = true;
            }
        }
    }

    return unwrapped;
}

function normalizeUrlEscapes(value) {
    return value
        .replace(/\\u0026/gi, '&')
        .replace(/\\u003d/gi, '=')
        .replace(/\\u002f/gi, '/')
        .replace(/&amp;/gi, '&');
}

function isExpediaHostname(hostname) {
    return EXPEDIA_HOST_PATTERN.test(hostname);
}

function extractNestedExpediaUrl(url) {
    if (isExpediaHostname(url.hostname)) return undefined;

    for (const key of ['url', 'u', 'target', 'dest', 'redirect', 'redir', 'r']) {
        const value = cleanText(url.searchParams.get(key));
        if (value && /expedia\./i.test(value)) return value;
    }

    return undefined;
}

function normalizeUrlInput(input) {
    const normalized = cleanText(input);
    if (!normalized) return undefined;

    const extractedCandidate = normalizeUrlEscapes(unwrapEnclosingPairs(normalized))
        .match(/https?:\/\/[^\s"'<>]+|(?:www\.)?expedia\.[^\s"'<>]+|\/Hotel-Search[^\s"'<>]*/i)?.[0]
        || normalizeUrlEscapes(unwrapEnclosingPairs(normalized));

    let candidate = extractedCandidate.trim().replace(/[.,;!?]+$/, '');

    if (candidate.startsWith('/')) {
        candidate = `https://www.expedia.com${candidate}`;
    } else if (!/^[a-z]+:\/\//i.test(candidate) && /(?:^|\/)(?:www\.)?expedia\./i.test(candidate)) {
        candidate = `https://${candidate}`;
    }

    try {
        const parsed = new URL(candidate);
        const nestedUrl = extractNestedExpediaUrl(parsed);
        if (nestedUrl) return normalizeUrlInput(nestedUrl);
        return parsed.toString();
    } catch {
        return undefined;
    }
}

function parseChildrenAges(value) {
    const cleaned = cleanText(value);
    if (!cleaned) return [];

    const matches = cleaned.match(/\d+/g) || [];
    if (!matches.length) return [];
    if (/^\d+$/.test(cleaned) && matches.length === 1) return [];

    return matches
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 17);
}

function parseDateParts(dateString) {
    const cleaned = cleanText(dateString);
    if (!cleaned) return undefined;

    const match = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return undefined;

    return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
    };
}

function formatDateParts(parts) {
    if (!parts) return undefined;
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function extractMatch(text, pattern) {
    return pattern.exec(text)?.[1];
}

function addDays(date, days) {
    const clone = new Date(date);
    clone.setUTCDate(clone.getUTCDate() + days);
    return clone;
}

function dateToParts(date) {
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
    };
}

function toUtcDate(parts) {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function getTodayUtc() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function getSafeFutureStayDates() {
    const today = getTodayUtc();
    const checkIn = addDays(today, DEFAULT_STAY_OFFSET_DAYS);
    const checkOut = addDays(checkIn, DEFAULT_STAY_LENGTH_DAYS);

    return {
        checkInDate: formatDateParts(dateToParts(checkIn)),
        checkOutDate: formatDateParts(dateToParts(checkOut)),
    };
}

function resolveStayDates({ checkInDate, checkOutDate }) {
    const today = getTodayUtc();
    const defaults = getSafeFutureStayDates();

    let parsedCheckIn = parseDateParts(checkInDate);
    if (!parsedCheckIn || toUtcDate(parsedCheckIn) < today) {
        parsedCheckIn = parseDateParts(defaults.checkInDate);
    }

    let parsedCheckOut = parseDateParts(checkOutDate);
    if (!parsedCheckOut || toUtcDate(parsedCheckOut) <= toUtcDate(parsedCheckIn)) {
        parsedCheckOut = dateToParts(addDays(toUtcDate(parsedCheckIn), DEFAULT_STAY_LENGTH_DAYS));
    }

    return {
        checkInDate: formatDateParts(parsedCheckIn),
        checkOutDate: formatDateParts(parsedCheckOut),
    };
}

function clampAdults(value) {
    const adults = toInteger(value);
    return adults !== undefined ? Math.max(1, Math.min(14, adults)) : 2;
}

function getFirstSearchParam(url, keys) {
    for (const key of keys) {
        const value = cleanText(url.searchParams.get(key));
        if (value !== undefined) return value;
    }

    return undefined;
}

function extractRegionIdFromPathname(pathname) {
    return pathname.match(/\.d(\d+)\./i)?.[1];
}

function extractDestinationFromPathname(pathname) {
    const match = pathname.match(/\/([^/?]+?)-Hotels(?:\.d\d+)?(?:\.Travel-Guide-Hotels)?(?:\/|$)/i)
        || pathname.match(/\/([^/?]+?)-Travel-Guide(?:\/|$)/i);
    if (!match) return undefined;

    return cleanText(match[1].replace(/-/g, ' '));
}

function getSelectionValue(criteria, id) {
    const selections = criteria?.secondary?.selections || [];
    return cleanText(selections.find((entry) => entry?.id === id)?.value);
}

function normalizeResourceUrl(resource) {
    const directValue = cleanText(resource?.value);
    if (directValue) return directValue;

    const relativePath = cleanText(resource?.relativePath);
    if (!relativePath) return undefined;

    try {
        return new URL(relativePath, 'https://www.expedia.com').toString();
    } catch {
        return undefined;
    }
}

function parseCookieHeader(setCookieHeaders = []) {
    return setCookieHeaders.map((entry) => entry.split(';')[0]).join('; ');
}

function hasLocalApifyProxyCredentials() {
    return Boolean(process.env.APIFY_TOKEN || process.env.APIFY_PROXY_PASSWORD);
}

function shouldUseLocalPreview(proxyInput) {
    if (Actor.isAtHome() || hasLocalApifyProxyCredentials()) return false;
    const normalizedProxyInput = normalizeProxyConfigurationInput(proxyInput);
    if (!normalizedProxyInput?.useApifyProxy) return false;
    return !Array.isArray(normalizedProxyInput.proxyUrls) || normalizedProxyInput.proxyUrls.length === 0;
}

function buildLocalPreviewRecord({ startUrl }) {
    const { checkInDate, checkOutDate } = getSafeFutureStayDates();

    return compactObject({
        hotel_id: 'local-preview',
        hotel_name: 'Local preview record - proxy required for live Expedia data',
        city: 'London',
        star_rating: 4,
        guest_rating: 8.8,
        guest_rating_out_of_five: 4.4,
        review_count: 1284,
        review_label: 'Excellent',
        nightly_price: '$125 nightly',
        total_price: '$149',
        free_cancellation: true,
        member_price_available: true,
        vacation_rental: false,
        image_url: 'https://images.trvl-media.com/lodging/1000000/10000/100/1/example.jpg',
        property_url: 'https://www.expedia.com/',
        region_id: '6139104',
        region_name: 'London, United Kingdom (LON-All Airports)',
        check_in: checkInDate,
        check_out: checkOutDate,
        adults: 2,
        children: [],
        sort: 'RECOMMENDED',
        search_id: 'local-preview',
        source_url: startUrl,
        operation_name: PROPERTY_LISTING_QUERY.operationName,
        scraped_at: new Date().toISOString(),
    });
}

function getImpitClient(proxyUrl) {
    const key = proxyUrl || 'direct';
    if (!impitClients.has(key)) {
        impitClients.set(key, new Impit({
            browser: 'chrome',
            ignoreTlsErrors: true,
            ...(proxyUrl && { proxyUrl }),
        }));
    }

    return impitClients.get(key);
}

function getSetCookieHeaders(headers) {
    if (!headers) return [];
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();

    const value = headers.get?.('set-cookie');
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function sleep(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function getCaseInsensitive(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    const lower = key.toLowerCase();
    for (const k of Object.keys(obj)) {
        if (k.toLowerCase() === lower) return obj[k];
    }
    return undefined;
}

function getNestedCaseInsensitive(obj, ...keys) {
    let current = obj;
    for (const key of keys) {
        if (current == null || typeof current !== 'object') return undefined;
        if (Array.isArray(current)) {
            const index = Number(key);
            current = Number.isFinite(index) ? current[index] : undefined;
        } else {
            current = getCaseInsensitive(current, key);
        }
    }
    return current;
}

async function retryWithBackoff(fn, options = {}) {
    const {
        label = 'request',
        maxAttempts = GRAPHQL_MAX_ATTEMPTS,
        baseBackoffMs = GRAPHQL_BASE_BACKOFF_MS,
        maxBackoffMs = GRAPHQL_MAX_BACKOFF_MS,
        retryableStatusCodes = GRAPHQL_RETRYABLE_STATUS_CODES,
        retryableErrorCodes = GRAPHQL_RETRYABLE_ERROR_CODES,
    } = options;

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            const statusCode = getErrorStatusCode(error);
            const isRetryable = statusCode
                ? retryableStatusCodes.has(statusCode)
                : retryableErrorCodes.has(error?.code)
                    || /timeout|econnreset|eai_again|etimedout|enotfound|enetunreach/i.test(error?.message || '');

            if (!isRetryable || attempt === maxAttempts) throw error;

            const jitter = Math.floor(Math.random() * 500);
            const delay = Math.min(maxBackoffMs, baseBackoffMs * (2 ** (attempt - 1)) + (statusCode === 429 ? 2000 : 0) + jitter);
            log.warning(`${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`, {
                statusCode,
                message: toErrorMessage(error),
            });
            await sleep(delay);
        }
    }

    throw lastError;
}

function toErrorMessage(error) {
    if (!error) return 'Unknown error';
    if (typeof error === 'string') return error;
    return cleanText(error.message) || 'Unknown error';
}

function createHttpStatusError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function getErrorStatusCode(error) {
    const statusCode = toInteger(error?.statusCode);
    if (statusCode !== undefined) return statusCode;

    const message = cleanText(error?.message) || '';
    const proxyMatch = message.match(/\bProxy responded with\s+(\d{3})\b/i);
    if (proxyMatch) return toInteger(proxyMatch[1]);

    const genericMatch = message.match(/\bstatus\s+(\d{3})\b/i);
    if (genericMatch) return toInteger(genericMatch[1]);

    return undefined;
}

function isBootstrapRetryableError(error) {
    const statusCode = getErrorStatusCode(error);
    if (statusCode !== undefined) {
        if (BOOTSTRAP_RETRYABLE_STATUS_CODES.has(statusCode)) return true;
        if (statusCode >= 590 && statusCode <= 599) return true;
    }

    const code = cleanText(error?.code) || '';
    if (BOOTSTRAP_RETRYABLE_ERROR_CODES.has(code)) return true;

    const message = cleanText(error?.message) || '';
    return /upstream5\d\d|proxy responded with 59\d/i.test(message);
}

function getBootstrapBackoffMs({ attempt, statusCode }) {
    const statusBoost = statusCode === 429 ? 600 : 0;
    const exponential = BOOTSTRAP_BASE_BACKOFF_MS * (2 ** Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * 450);
    return Math.min(BOOTSTRAP_MAX_BACKOFF_MS, exponential + statusBoost + jitter);
}

function shouldSkipRemainingSearchUrls(error) {
    const statusCode = getErrorStatusCode(error);
    if (statusCode !== undefined) {
        if (statusCode === 403 || statusCode === 429) return true;
        if (statusCode >= 590 && statusCode <= 599) return true;
    }

    const code = cleanText(error?.code) || '';
    if (BOOTSTRAP_RETRYABLE_ERROR_CODES.has(code)) return true;

    const message = cleanText(error?.message) || '';
    return /upstream5\d\d|proxy responded with 59\d/i.test(message);
}

function shouldAbandonBootstrapStrategy({ error, attempt, hasProxy }) {
    const statusCode = getErrorStatusCode(error);
    if (statusCode === 429) return attempt >= 2;
    if (statusCode === 403) return attempt >= (hasProxy ? 2 : 1);
    if (statusCode !== undefined && statusCode >= 590 && statusCode <= 599) return true;

    const code = cleanText(error?.code) || '';
    if (BOOTSTRAP_RETRYABLE_ERROR_CODES.has(code)) return attempt >= 2;

    return false;
}

function normalizeProxyConfigurationInput(proxyInput) {
    if (!proxyInput || typeof proxyInput !== 'object') return proxyInput;

    const normalized = { ...proxyInput };
    if (!Array.isArray(normalized.groups) && Array.isArray(normalized.apifyProxyGroups)) {
        normalized.groups = normalized.apifyProxyGroups;
    }

    return normalized;
}

function inferPreferredCountryCodeFromStartUrl(startUrl) {
    const parsed = parseStartUrlSearchInput(startUrl);
    const destination = cleanText(parsed.destination)?.toLowerCase() || '';

    if (/united kingdom|\buk\b|england|london|scotland|wales|northern ireland/.test(destination)) return 'GB';
    if (/united states|\busa\b|new york|los angeles|chicago|miami/.test(destination)) return 'US';
    if (/canada|toronto|vancouver|montreal/.test(destination)) return 'CA';
    if (/australia|sydney|melbourne|brisbane/.test(destination)) return 'AU';
    if (/india|delhi|mumbai|bangalore/.test(destination)) return 'IN';
    if (/pakistan|karachi|lahore|islamabad/.test(destination)) return 'PK';
    if (/germany|berlin|munich|frankfurt/.test(destination)) return 'DE';
    if (/france|paris|lyon|marseille/.test(destination)) return 'FR';
    if (/italy|rome|milan|florence/.test(destination)) return 'IT';
    if (/spain|madrid|barcelona|valencia/.test(destination)) return 'ES';

    return undefined;
}

async function buildProxyStrategies(proxyInput, startUrl) {
    const strategies = [];
    const usedLabels = new Set();
    const addStrategy = (label, proxyConfiguration) => {
        if (usedLabels.has(label)) return;
        usedLabels.add(label);
        strategies.push({ label, proxyConfiguration });
    };

    let userProxyConfiguration;
    const normalizedProxyInput = normalizeProxyConfigurationInput(proxyInput);
    const isExplicitlyNoApifyProxy = normalizedProxyInput?.useApifyProxy === false;
    const hasLocalApifyCredentials = hasLocalApifyProxyCredentials();
    const shouldTryApifyFallback = Actor.isAtHome() || hasLocalApifyCredentials;
    const hasCustomProxyUrls = Array.isArray(normalizedProxyInput?.proxyUrls) && normalizedProxyInput.proxyUrls.length > 0;
    const usesApifyProxy = Boolean(
        normalizedProxyInput?.useApifyProxy
        || normalizedProxyInput?.groups
        || normalizedProxyInput?.apifyProxyGroups,
    );
    const canUseInputProxy = normalizedProxyInput && (!usesApifyProxy || hasCustomProxyUrls || shouldTryApifyFallback);

    if (canUseInputProxy) {
        try {
            userProxyConfiguration = await Actor.createProxyConfiguration(normalizedProxyInput);
            if (userProxyConfiguration) addStrategy('input_proxy_configuration', userProxyConfiguration);
        } catch (error) {
            log.warning('Proxy configuration initialization failed, continuing with fallback strategies.', {
                message: toErrorMessage(error),
            });
        }
    } else if (normalizedProxyInput) {
        log.warning('Apify proxy was requested but no local proxy credentials were found. Skipping direct Expedia requests to avoid 429 responses.');
    } else {
        addStrategy('direct_no_proxy', undefined);
    }

    const preferredCountryCode = inferPreferredCountryCodeFromStartUrl(startUrl);
    const canUseApifyFallback = !isExplicitlyNoApifyProxy;

    if (canUseApifyFallback && shouldTryApifyFallback) {
        const fallbackConfigs = [
            ...(preferredCountryCode ? [{
                label: `auto_residential_${preferredCountryCode.toLowerCase()}`,
                options: { useApifyProxy: true, groups: ['RESIDENTIAL'], countryCode: preferredCountryCode },
            }] : []),
            { label: 'auto_residential_us', options: { useApifyProxy: true, groups: ['RESIDENTIAL'], countryCode: 'US' } },
            { label: 'auto_residential_any', options: { useApifyProxy: true, groups: ['RESIDENTIAL'] } },
            { label: 'auto_apify_proxy', options: { useApifyProxy: true } },
        ];

        for (const fallback of fallbackConfigs) {
            try {
                const proxyConfiguration = await Actor.createProxyConfiguration(fallback.options);
                if (proxyConfiguration) addStrategy(fallback.label, proxyConfiguration);
            } catch (error) {
                log.warning('Could not initialize proxy fallback strategy.', {
                    strategy: fallback.label,
                    message: toErrorMessage(error),
                });
            }
        }
    }

    if (!normalizedProxyInput && !strategies.some((entry) => entry.label === 'direct_no_proxy')) {
        addStrategy('direct_no_proxy', undefined);
    }

    if (!strategies.length) {
        throw new Error('No usable proxy strategy available. Provide APIFY_TOKEN/APIFY_PROXY_PASSWORD locally or run the actor on Apify with proxy access enabled.');
    }

    return strategies;
}

function parseStartUrlSearchInput(startUrl) {
    const explicitUrl = normalizeUrlInput(startUrl);
    if (!explicitUrl) return {};

    try {
        const url = new URL(explicitUrl);
        return {
            rawUrl: url.toString(),
            origin: url.origin,
            pathname: url.pathname,
            regionId: getFirstSearchParam(url, ['regionId', 'regionid']) || extractRegionIdFromPathname(url.pathname),
            destination: getFirstSearchParam(url, ['destination', 'regionName', 'placeName']) || extractDestinationFromPathname(url.pathname),
            checkInDate: getFirstSearchParam(url, ['startDate', 'checkInDate', 'checkin', 'checkIn']),
            checkOutDate: getFirstSearchParam(url, ['endDate', 'checkOutDate', 'checkout', 'checkOut']),
            adults: toInteger(getFirstSearchParam(url, ['adults', 'adultCount'])),
            children: getFirstSearchParam(url, ['children', 'childAges']) || '',
            sort: getFirstSearchParam(url, ['sort', 'sortBy']),
        };
    } catch {
        return {};
    }
}

function buildCanonicalSearchUrl(searchInput) {
    const explicitUrl = normalizeUrlInput(searchInput?.rawUrl);
    const url = explicitUrl ? new URL(explicitUrl) : new URL('https://www.expedia.com/Hotel-Search');
    const origin = isExpediaHostname(url.hostname) ? url.origin : 'https://www.expedia.com';
    const canonical = new URL('/Hotel-Search', origin);
    const { checkInDate, checkOutDate } = resolveStayDates(searchInput || {});
    const regionId = cleanText(searchInput?.regionId);
    const destination = cleanText(searchInput?.destination);
    const sort = cleanText(searchInput?.sort) || 'RECOMMENDED';
    const children = parseChildrenAges(searchInput?.children).join(',');

    if (regionId) canonical.searchParams.set('regionId', regionId);
    if (destination) canonical.searchParams.set('destination', destination);
    canonical.searchParams.set('startDate', checkInDate);
    canonical.searchParams.set('endDate', checkOutDate);
    canonical.searchParams.set('adults', String(clampAdults(searchInput?.adults)));
    canonical.searchParams.set('children', children);
    canonical.searchParams.set('sort', sort);
    canonical.searchParams.set('useRewards', 'false');
    canonical.searchParams.set('vip', 'false');

    return canonical.toString();
}

function buildSearchUrlCandidates(startUrl) {
    const parsed = parseStartUrlSearchInput(startUrl);
    const candidates = [];
    const addCandidate = (value) => {
        const normalized = normalizeUrlInput(value);
        if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
    };

    addCandidate(buildCanonicalSearchUrl(parsed));
    addCandidate(parsed.rawUrl || startUrl);

    return candidates;
}

function resolveNormalizedSearchInput(...sources) {
    const pickValue = (transform, key) => {
        for (const source of sources) {
            if (!source) continue;

            const value = transform(source[key]);
            if (value !== undefined && value !== '') return value;
        }

        return undefined;
    };

    const normalizedInput = {
        rawUrl: pickValue(normalizeUrlInput, 'rawUrl'),
        origin: pickValue(cleanText, 'origin'),
        pathname: pickValue(cleanText, 'pathname'),
        regionId: pickValue(cleanText, 'regionId'),
        destination: pickValue(cleanText, 'destination'),
        adults: clampAdults(pickValue((value) => value, 'adults')),
        children: pickValue((value) => cleanText(value) || '', 'children') || '',
        sort: pickValue(cleanText, 'sort') || 'RECOMMENDED',
    };

    const resolvedDates = resolveStayDates({
        checkInDate: pickValue(cleanText, 'checkInDate'),
        checkOutDate: pickValue(cleanText, 'checkOutDate'),
    });

    normalizedInput.checkInDate = resolvedDates.checkInDate;
    normalizedInput.checkOutDate = resolvedDates.checkOutDate;
    normalizedInput.startUrl = buildCanonicalSearchUrl(normalizedInput);

    if (!normalizedInput.regionId && !normalizedInput.destination) {
        throw new Error('Could not determine destination from startUrl. Provide an Expedia Hotel-Search or Expedia destination page URL that contains a destination or region.');
    }

    return normalizedInput;
}

function getSchemaFieldValue(fieldSchema) {
    if (!fieldSchema || typeof fieldSchema !== 'object') return undefined;

    if (fieldSchema.prefill !== undefined) {
        if (typeof fieldSchema.prefill !== 'string') return fieldSchema.prefill;

        const trimmed = fieldSchema.prefill.trim();
        if (trimmed) return trimmed;
    }

    return fieldSchema.default;
}

async function loadInputSchemaDefaults() {
    try {
        const raw = await readFile(new URL('../.actor/input_schema.json', import.meta.url), 'utf8');
        const schema = JSON.parse(raw);
        const properties = schema?.properties || {};
        const resultsWantedField = properties.resultsWanted || properties.results_wanted;
        const maxPagesField = properties.maxPages || properties.max_pages;

        return {
            startUrl: normalizeUrlInput(getSchemaFieldValue(properties.startUrl)),
            resultsWanted: toInteger(getSchemaFieldValue(resultsWantedField)),
            maxPages: toInteger(getSchemaFieldValue(maxPagesField)),
        };
    } catch {
        return {};
    }
}

function buildBootstrapData(html, cookieHeader) {
    const normalizedHtml = html.replace(/\\"/g, '"');

    const applicationName = extractMatch(normalizedHtml, /"applicationName":"([^"]+)"/);
    const applicationVersion = extractMatch(normalizedHtml, /"app_version":"([^"]+)"/)
        || extractMatch(normalizedHtml, /"applicationReleaseVersion":"bex-branch-([^"]+)"/);
    const awsRegion = extractMatch(normalizedHtml, /"awsRegion":"([^"]+)"/);
    const pageId = extractMatch(normalizedHtml, /"pageId":"([^"]+)"/);
    const searchId = extractMatch(normalizedHtml, /"searchId":"([^"]+)"/);
    const productOffersId = extractMatch(normalizedHtml, /"productOffersId":"([^"]+)"/);
    const duaid = extractMatch(cookieHeader, /(?:^|;\s*)DUAID=([^;]+)/);
    const resultsStartingIndex = toInteger(extractMatch(normalizedHtml, /"resultsStartingIndex":(\d+)/));
    const resultsSize = toInteger(extractMatch(normalizedHtml, /"resultsSize":(\d+)/));

    const missing = [];
    if (!applicationName) missing.push('applicationName');
    if (!applicationVersion) missing.push('applicationVersion');
    if (!awsRegion) missing.push('awsRegion');
    if (!pageId) missing.push('pageId');
    if (!searchId) missing.push('searchId');
    if (!productOffersId) missing.push('productOffersId');
    if (!duaid) missing.push('DUAID cookie');

    if (missing.length) {
        throw new Error(`Could not derive Expedia API bootstrap values: ${missing.join(', ')}`);
    }

    return {
        clientInfo: `${applicationName},${applicationVersion},${awsRegion}`,
        pageId,
        searchId,
        productOffersId,
        duaid,
        resultsStartingIndex: resultsStartingIndex ?? 3,
        resultsSize: resultsSize ?? 97,
        ctxViewId: crypto.randomUUID(),
    };
}

function buildRequestPayload({ input, bootstrapData, startIndex, size }) {
    const children = parseChildrenAges(input.children);

    return {
        operationName: PROPERTY_LISTING_QUERY.operationName,
        variables: {
            context: {
                siteId: 1,
                locale: 'en_US',
                eapid: 0,
                tpid: 1,
                currency: 'USD',
                device: { type: 'DESKTOP' },
                identity: {
                    duaid: bootstrapData.duaid,
                    authState: 'ANONYMOUS',
                },
                privacyTrackingState: 'CAN_TRACK',
            },
            criteria: {
                primary: {
                    dateRange: {
                        checkInDate: parseDateParts(input.checkInDate),
                        checkOutDate: parseDateParts(input.checkOutDate),
                    },
                    destination: {
                        regionName: cleanText(input.destination),
                        regionId: cleanText(input.regionId),
                        coordinates: null,
                        pinnedPropertyId: null,
                        propertyIds: null,
                        mapBounds: null,
                    },
                    rooms: [{
                        adults: toInteger(input.adults) ?? 2,
                        children: children.map((age) => ({ age })),
                    }],
                },
                secondary: {
                    counts: [
                        { id: 'resultsStartingIndex', value: startIndex },
                        { id: 'resultsSize', value: size },
                    ],
                    booleans: [],
                    selections: [
                        { id: 'privacyTrackingState', value: 'CAN_TRACK' },
                        { id: 'productOffersId', value: bootstrapData.productOffersId },
                        { id: 'searchId', value: bootstrapData.searchId },
                        { id: 'sort', value: cleanText(input.sort) || 'RECOMMENDED' },
                        { id: 'useRewards', value: 'SHOP_WITHOUT_POINTS' },
                    ],
                    ranges: [],
                },
            },
            shoppingContext: {
                multiItem: null,
                queryTriggeredBy: 'PAGE-LOAD',
                typeaheadCollationId: null,
            },
        },
        extensions: {
            persistedQuery: {
                version: 1,
                sha256Hash: PROPERTY_LISTING_QUERY.hash,
            },
        },
    };
}

function parseProductAnalytics(card) {
    const events = Array.isArray(card?.analyticsEvents) ? card.analyticsEvents : [];

    for (const event of events) {
        const attribute = event?.attribute;
        if (!attribute || (cleanText(attribute.name) || '').toLowerCase() !== 'product_list') continue;

        const content = cleanText(attribute.content);
        if (!content) continue;

        try {
            const parsed = JSON.parse(content);
            const first = Array.isArray(parsed) ? parsed[0] : parsed;
            if (first && typeof first === 'object') return first;
        } catch {
            continue;
        }
    }

    return {};
}

function buildAnalyticsMap(result) {
    const raw = getNestedCaseInsensitive(result, 'extensions', 'analytics', '0', 'tealiumUtagData', 'entity', 'hotels', 'results', 'results');
    const items = Array.isArray(raw) ? raw : [];
    const analyticsMap = new Map();

    for (const item of items) {
        const hotelId = cleanText(getCaseInsensitive(item, 'hotelId'));
        if (hotelId) analyticsMap.set(hotelId, item);
    }

    return analyticsMap;
}

function parseReviewCount(card, analyticsItem) {
    const reviewText = cleanText(card?.summarySections?.[0]?.reviewSummary?.subtexts?.[0]?.shoppingProductTitle?.text);
    const fromCard = toInteger(reviewText?.replace(/[^\d]/g, ''));
    if (fromCard !== undefined) return fromCard;
    return toInteger(analyticsItem?.reviewSummary?.totalReviews);
}

function normalizeHotelRecord({ card, criteria, analyticsItem, sourceUrl, scrapedAt }) {
    const productAnalytics = parseProductAnalytics(card);
    const hotelId = cleanText(card?.id) || cleanText(analyticsItem?.hotelId);
    if (!hotelId) return undefined;

    return compactObject({
        hotel_id: hotelId,
        hotel_name: cleanText(card?.headingSection?.heading),
        city: cleanText(card?.headingSection?.messages?.[0]?.text),
        star_rating: toNumber(analyticsItem?.starRating),
        guest_rating: toNumber(card?.summarySections?.[0]?.reviewSummary?.graphic?.text),
        guest_rating_out_of_five: toNumber(analyticsItem?.reviewSummary?.guestRating),
        review_count: parseReviewCount(card, analyticsItem),
        review_label: cleanText(card?.summarySections?.[0]?.reviewSummary?.title?.shoppingProductTitle?.text),
        nightly_price: cleanText(card?.priceSection?.priceSummary?.displayMessages?.[0]?.lineItems?.[0]?.value),
        total_price: cleanText(card?.priceSection?.priceSummary?.options?.[0]?.displayPrice?.formatted),
        strikeout_price: cleanText(card?.priceSection?.priceSummary?.options?.[0]?.strikeOut?.formatted),
        taxes_and_fees_note: cleanText(card?.priceSection?.priceSummary?.displayMessages?.[2]?.lineItems?.[0]?.value),
        free_cancellation: typeof productAnalytics?.free_cancellation_bool === 'boolean'
            ? productAnalytics.free_cancellation_bool
            : undefined,
        member_price_available: cleanText(card?.mediaSection?.badges?.tertiaryBadge?.text)?.toLowerCase().includes('member price')
            || (Array.isArray(productAnalytics?.lodging_product?.badges) && productAnalytics.lodging_product.badges.includes('Available_MOD'))
            || undefined,
        vacation_rental: typeof analyticsItem?.vacationRental === 'boolean' ? analyticsItem.vacationRental : undefined,
        image_url: cleanText(card?.mediaSection?.gallery?.media?.[0]?.media?.url),
        property_url: normalizeResourceUrl(card?.cardLink?.resource),
        region_id: cleanText(criteria?.primary?.destination?.regionId),
        region_name: cleanText(criteria?.primary?.destination?.regionName),
        check_in: formatDateParts(criteria?.primary?.dateRange?.checkInDate),
        check_out: formatDateParts(criteria?.primary?.dateRange?.checkOutDate),
        adults: toInteger(criteria?.primary?.rooms?.[0]?.adults),
        children: (criteria?.primary?.rooms?.[0]?.children || [])
            .map((child) => toInteger(child?.age))
            .filter((age) => age !== undefined),
        sort: getSelectionValue(criteria, 'sort'),
        search_id: getSelectionValue(criteria, 'searchId'),
        source_url: sourceUrl,
        operation_name: PROPERTY_LISTING_QUERY.operationName,
        scraped_at: scrapedAt,
    });
}

async function loadInput() {
    const actorInput = await Actor.getInput();
    if (actorInput && typeof actorInput === 'object') return actorInput;

    try {
        const raw = await readFile(new URL('../INPUT.json', import.meta.url), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            log.info('Using local INPUT.json fallback because Actor input was empty.');
            return parsed;
        }
    } catch {
        // Ignore local fallback failure.
    }

    return {};
}

async function fetchSearchPage({ searchUrl, proxyUrl }) {
    const response = await getImpitClient(proxyUrl).fetch(searchUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status < 200 || response.status >= 400) {
        throw createHttpStatusError(`Search page request failed with status ${response.status}`, response.status);
    }

    return {
        body: await response.text(),
        headers: {
            'set-cookie': getSetCookieHeaders(response.headers),
        },
        statusCode: response.status,
        url: response.url,
    };
}

async function loadApiDiscoveryOverrides() {
    try {
        const raw = await readFile(new URL('../API_DISCOVERY.md', import.meta.url), 'utf8');
        const operationName = cleanText(extractMatch(raw, /- Operation:\s*([^\r\n]+)/i));
        const persistedQueryHash = cleanText(extractMatch(raw, /- Persisted Query Hash:\s*([a-f0-9]{32,128})/i));
        const endpoint = cleanText(extractMatch(raw, /- Endpoint:\s*(https?:\/\/[^\s\r\n]+)/i));

        return compactObject({
            operationName,
            persistedQueryHash,
            endpoint,
        }) || {};
    } catch {
        return {};
    }
}

async function bootstrapSearchSession({ searchUrlCandidates, proxyStrategies }) {
    let lastError;

    for (const strategy of proxyStrategies) {
        const hasProxy = Boolean(strategy.proxyConfiguration);
        const maxAttempts = hasProxy ? BOOTSTRAP_MAX_ATTEMPTS_WITH_PROXY : BOOTSTRAP_MAX_ATTEMPTS_WITHOUT_PROXY;
        let abortStrategy = false;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            let proxyUrl;

            if (strategy.proxyConfiguration) {
                try {
                    const sessionId = `bootstrap${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
                    proxyUrl = await strategy.proxyConfiguration.newUrl(sessionId);
                } catch (error) {
                    lastError = error;
                    log.warning('Proxy URL generation failed, switching strategy.', {
                        strategy: strategy.label,
                        attempt,
                        message: toErrorMessage(error),
                    });
                    break;
                }
            }

            for (const [candidateIndex, searchUrl] of searchUrlCandidates.entries()) {
                try {
                    const pageResponse = await fetchSearchPage({ searchUrl, proxyUrl });
                    const html = String(pageResponse.body || '');
                    const cookieHeader = parseCookieHeader(pageResponse.headers['set-cookie'] || []);
                    const bootstrapData = buildBootstrapData(html, cookieHeader);

                    return {
                        pageResponse,
                        searchUrl,
                        proxyUrl,
                        cookieHeader,
                        bootstrapData,
                        proxyStrategy: strategy.label,
                    };
                } catch (error) {
                    lastError = error;
                    const statusCode = getErrorStatusCode(error);
                    const retryable = isBootstrapRetryableError(error);
                    const abandonStrategyEarly = shouldAbandonBootstrapStrategy({ error, attempt, hasProxy });
                    const skipRemainingSearchUrls = shouldSkipRemainingSearchUrls(error) && candidateIndex < searchUrlCandidates.length - 1;

                    if (abandonStrategyEarly) {
                        abortStrategy = true;
                        log.debug('Bootstrap strategy abandoned after repeated blocking responses.', {
                            strategy: strategy.label,
                            attempt,
                            statusCode,
                            message: toErrorMessage(error),
                        });
                        break;
                    }

                    if (retryable) {
                        log.debug('Bootstrap attempt failed, retrying.', {
                            strategy: strategy.label,
                            attempt,
                            statusCode,
                            message: toErrorMessage(error),
                        });
                        await sleep(getBootstrapBackoffMs({ attempt, statusCode }));
                    } else {
                        log.debug('Bootstrap failed with non-retryable error.', {
                            strategy: strategy.label,
                            attempt,
                            statusCode,
                            message: toErrorMessage(error),
                        });
                    }

                    if (skipRemainingSearchUrls) {
                        break;
                    }
                }
            }

            if (abortStrategy) break;
        }
    }

    const statusCode = getErrorStatusCode(lastError);
    if (statusCode === 429) {
        throw new Error('Could not initialize Expedia search session from startUrl. Expedia returned anti-bot 429/challenge responses. Enable Apify residential proxy in proxyConfiguration and retry.');
    }

    throw new Error(`Could not initialize Expedia search session from startUrl. ${lastError?.message || ''}`.trim());
}

async function fetchListingBatch({ graphQlUrl, searchUrl, proxyUrl, cookieHeader, bootstrapData, payload, cookieState }) {
    return retryWithBackoff(async () => {
        const headers = {
            'content-type': 'application/json',
            'client-info': bootstrapData.clientInfo,
            'x-page-id': bootstrapData.pageId,
            'x-enable-apq': 'true',
            'x-shopping-product-line': 'lodging',
            'ctx-view-id': bootstrapData.ctxViewId,
            origin: 'https://www.expedia.com',
            referer: searchUrl,
            cookie: cookieHeader,
        };

        const response = await getImpitClient(proxyUrl).fetch(graphQlUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify([payload]),
            redirect: 'follow',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        const setCookieHeaders = getSetCookieHeaders(response.headers);
        if (cookieState && setCookieHeaders.length) {
            // eslint-disable-next-line no-param-reassign
            cookieState.cookieHeader = parseCookieHeader(setCookieHeaders);
        }

        const responseBody = await response.text();
        if (response.status < 200 || response.status >= 400) {
            const error = new Error(`PropertyListingQuery failed with status ${response.status}: ${responseBody.slice(0, 300)}`);
            error.statusCode = response.status;
            throw error;
        }

        const parsedBody = JSON.parse(responseBody);
        const result = Array.isArray(parsedBody) ? parsedBody[0] : parsedBody;
        const hasErrors = Array.isArray(result?.errors) && result.errors.length;
        if (hasErrors) {
            const messages = result.errors.map((entry) => entry.message).filter(Boolean);
            const isFatal = messages.some((m) => /not found|unauthorized|forbidden/i.test(m));
            if (isFatal) throw new Error(messages.join('; '));
            log.warning('GraphQL response contained non-fatal errors, continuing with partial data.', {
                errors: messages.join('; '),
            });
        }

        return result;
    }, { label: 'PropertyListingQuery', maxAttempts: GRAPHQL_MAX_ATTEMPTS, baseBackoffMs: GRAPHQL_BASE_BACKOFF_MS, maxBackoffMs: GRAPHQL_MAX_BACKOFF_MS });
}

async function main() {
    const input = await loadInput();
    const schemaDefaults = await loadInputSchemaDefaults();
    const apiDiscoveryOverrides = await loadApiDiscoveryOverrides();
    if (apiDiscoveryOverrides.operationName) PROPERTY_LISTING_QUERY.operationName = apiDiscoveryOverrides.operationName;
    if (apiDiscoveryOverrides.persistedQueryHash) PROPERTY_LISTING_QUERY.hash = apiDiscoveryOverrides.persistedQueryHash;
    if (Object.keys(apiDiscoveryOverrides).length) {
        log.info('Loaded API discovery overrides.', {
            operationName: apiDiscoveryOverrides.operationName || PROPERTY_LISTING_QUERY.operationName,
            operationHash: apiDiscoveryOverrides.persistedQueryHash || PROPERTY_LISTING_QUERY.hash,
            endpoint: apiDiscoveryOverrides.endpoint || 'derived_from_search_page',
        });
    }
    const {
        startUrl: startUrlRaw,
        resultsWanted: resultsWantedCamelRaw,
        results_wanted: resultsWantedRaw,
        maxPages: maxPagesCamelRaw,
        max_pages: maxPagesRaw,
        proxyConfiguration: proxyInput,
    } = input;
    const startUrl = normalizeUrlInput(startUrlRaw ?? schemaDefaults.startUrl);
    if (!startUrl) {
        throw new Error('Missing startUrl. Provide an Expedia Hotel-Search URL or Expedia destination/listing URL.');
    }

    const resultsWantedSource = resultsWantedCamelRaw
        ?? resultsWantedRaw
        ?? schemaDefaults.resultsWanted;
    const maxPagesSource = maxPagesCamelRaw
        ?? maxPagesRaw
        ?? schemaDefaults.maxPages;
    const resultsWanted = Number.isFinite(+resultsWantedSource) ? Math.max(1, Math.min(500, +resultsWantedSource)) : 20;
    const maxPages = Number.isFinite(+maxPagesSource) ? Math.max(1, Math.min(50, +maxPagesSource)) : 8;
    const searchUrlCandidates = buildSearchUrlCandidates(startUrl);
    if (!searchUrlCandidates.length) {
        throw new Error('Could not normalize startUrl into a valid Expedia URL.');
    }

    if (shouldUseLocalPreview(proxyInput)) {
        log.warning('Local Apify proxy credentials are missing. Writing a preview dataset item instead of sending direct Expedia requests that return 429.');
        await Actor.pushData(buildLocalPreviewRecord({ startUrl }));
        log.info('Finished local preview run', {
            saved: 1,
            requested: resultsWanted,
            liveExtraction: false,
        });
        return;
    }

    const proxyStrategies = await buildProxyStrategies(proxyInput, startUrl);
    log.debug('Prepared proxy recovery strategies.', {
        strategies: proxyStrategies.map((entry) => entry.label),
    });
    const scrapedAt = new Date().toISOString();

    let searchSession = await bootstrapSearchSession({ searchUrlCandidates, proxyStrategies });
    let normalizedInput = resolveNormalizedSearchInput(
        parseStartUrlSearchInput(searchSession.pageResponse.url || searchSession.searchUrl),
        parseStartUrlSearchInput(searchSession.searchUrl),
        parseStartUrlSearchInput(startUrl),
    );
    let graphQlUrl = apiDiscoveryOverrides.endpoint
        || new URL('/graphql', searchSession.pageResponse.url || searchSession.searchUrl).toString();

    log.info('Starting Expedia hotel listing extraction', {
        startUrl: normalizedInput.startUrl,
        recoveryCandidates: searchUrlCandidates.length,
        operationName: PROPERTY_LISTING_QUERY.operationName,
        operationHash: PROPERTY_LISTING_QUERY.hash,
        resultsWanted,
        maxPages,
        usingProxy: Boolean(searchSession.proxyUrl),
        proxyStrategy: searchSession.proxyStrategy,
    });

    const seenHotelIds = new Set();
    const records = [];
    let startIndex = searchSession.bootstrapData.resultsStartingIndex;
    const batchSize = searchSession.bootstrapData.resultsSize;
    const cookieState = { cookieHeader: searchSession.cookieHeader };

    for (let pageNumber = 1; pageNumber <= maxPages && records.length < resultsWanted; pageNumber++) {
        let payload = buildRequestPayload({
            input: normalizedInput,
            bootstrapData: searchSession.bootstrapData,
            startIndex,
            size: batchSize,
        });

        let result;
        try {
            result = await fetchListingBatch({
                graphQlUrl,
                searchUrl: searchSession.pageResponse.url || searchSession.searchUrl,
                proxyUrl: searchSession.proxyUrl,
                cookieHeader: cookieState.cookieHeader,
                bootstrapData: searchSession.bootstrapData,
                payload,
                cookieState,
            });
        } catch (error) {
            log.warning('Listing batch failed, refreshing the search session before retrying once.', {
                pageNumber,
                startIndex,
                message: error.message,
            });

            searchSession = await bootstrapSearchSession({
                searchUrlCandidates: [normalizedInput.startUrl, ...searchUrlCandidates],
                proxyStrategies,
            });
            cookieState.cookieHeader = searchSession.cookieHeader;
            normalizedInput = resolveNormalizedSearchInput(
                parseStartUrlSearchInput(searchSession.pageResponse.url || searchSession.searchUrl),
                parseStartUrlSearchInput(normalizedInput.startUrl),
                parseStartUrlSearchInput(startUrl),
            );
            graphQlUrl = apiDiscoveryOverrides.endpoint
                || new URL('/graphql', searchSession.pageResponse.url || searchSession.searchUrl).toString();
            payload = buildRequestPayload({
                input: normalizedInput,
                bootstrapData: searchSession.bootstrapData,
                startIndex,
                size: batchSize,
            });
            result = await fetchListingBatch({
                graphQlUrl,
                searchUrl: searchSession.pageResponse.url || searchSession.searchUrl,
                proxyUrl: searchSession.proxyUrl,
                cookieHeader: cookieState.cookieHeader,
                bootstrapData: searchSession.bootstrapData,
                payload,
                cookieState,
            });
        }

        const { criteria } = payload.variables;
        const analyticsMap = buildAnalyticsMap(result);
        const listings = getNestedCaseInsensitive(result, 'data', 'propertySearch', 'propertySearchListings');
        const cards = (Array.isArray(listings) ? listings : []).filter((entry) => {
            const typeName = cleanText(getCaseInsensitive(entry || {}, '__typename'));
            return typeName && typeName.toLowerCase() === 'lodgingcard';
        });

        if (!cards.length) break;

        for (const card of cards) {
            if (records.length >= resultsWanted) break;

            try {
                const hotelId = cleanText(card?.id);
                const analyticsItem = hotelId ? analyticsMap.get(hotelId) : undefined;
                const record = normalizeHotelRecord({
                    card,
                    criteria,
                    analyticsItem,
                    sourceUrl: graphQlUrl,
                    scrapedAt,
                });

                if (!record?.hotel_id || seenHotelIds.has(record.hotel_id)) continue;

                seenHotelIds.add(record.hotel_id);
                records.push(record);
            } catch (error) {
                log.warning('Skipped hotel card due to processing error.', {
                    hotelId: cleanText(card?.id),
                    message: toErrorMessage(error),
                });
            }
        }

        log.info(`Saved ${records.length}/${resultsWanted} hotel listings after page ${pageNumber}`);

        if (cards.length < batchSize) break;
        startIndex += batchSize;

        if (pageNumber < maxPages && records.length < resultsWanted) {
            const pageDelay = PAGE_REQUEST_DELAY_MIN_MS + Math.floor(Math.random() * (PAGE_REQUEST_DELAY_MAX_MS - PAGE_REQUEST_DELAY_MIN_MS));
            await sleep(pageDelay);
        }
    }

    if (!records.length) {
        throw new Error('No hotel listings extracted. Verify the Expedia Hotel-Search URL or use residential proxies if the endpoint is blocked.');
    }

    await Actor.pushData(records);

    log.info('Finished successfully', {
        saved: records.length,
        requested: resultsWanted,
    });
}

try {
    await main();
    await Actor.exit();
} catch (error) {
    log.exception(error, 'Actor failed');
    await Actor.fail(error.message);
}
