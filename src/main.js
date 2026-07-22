import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { Impit } from 'impit';

await Actor.init();

const PROPERTY_LISTING_QUERY = {
    operationName: 'PropertyListingQuery',
    hash: '82abb7da6738db4c904e4d10130072236a751b5a315f6dfaf92474793597bc33',
};

const HOME_URL = 'https://www.expedia.com/';
const IOS_SAFARI_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const WARMUP_PROFILES = [
    {
        name: 'ios-safari-standard',
        browser: 'chrome',
        extraHeaders: {},
    },
    {
        name: 'ios-safari-firefox-transport',
        browser: 'firefox',
        extraHeaders: {},
    },
    {
        name: 'ios-safari-cache-control',
        browser: 'chrome',
        extraHeaders: {
            'cache-control': 'no-cache',
            pragma: 'no-cache',
            'upgrade-insecure-requests': '1',
            priority: 'u=0, i',
        },
    },
    {
        name: 'ios-safari-firefox-cache-control',
        browser: 'firefox',
        extraHeaders: {
            'cache-control': 'no-cache',
            pragma: 'no-cache',
            'upgrade-insecure-requests': '1',
            priority: 'u=0, i',
        },
    },
];
const HOTEL_LISTING_PAGE_ID_FALLBACK = 'page.Hotel-Search,H,20';
const HOTEL_LISTING_CLIENT_INFO_FALLBACK = 'shopping-pwa,unknown,us-east-1';

const EXPEDIA_HOST_PATTERN = /(^|\.)expedia\.[a-z.]+$/i;
const DEFAULT_STAY_OFFSET_DAYS = 30;
const DEFAULT_STAY_LENGTH_DAYS = 1;
const BOOTSTRAP_RETRYABLE_STATUS_CODES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const BOOTSTRAP_RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
const BOOTSTRAP_BASE_BACKOFF_MS = 900;
const BOOTSTRAP_MAX_BACKOFF_MS = 4500;
const BOOTSTRAP_MAX_ATTEMPTS_WITHOUT_PROXY = 2;
const BOOTSTRAP_MAX_ATTEMPTS_WITH_PROXY = 8;

const GRAPHQL_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const GRAPHQL_RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'ENETUNREACH']);
const GRAPHQL_BASE_BACKOFF_MS = 1000;
const GRAPHQL_MAX_BACKOFF_MS = 10000;
const GRAPHQL_MAX_ATTEMPTS = 3;

const PAGE_REQUEST_DELAY_MIN_MS = 1500;
const PAGE_REQUEST_DELAY_MAX_MS = 4000;

const impitInstances = new Map();

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

function mergeCookieHeaderStrings(existing, fresh) {
    if (!fresh) return existing;
    const cookies = new Map();
    for (const cookieHeader of [existing, fresh]) {
        for (const cookiePair of cleanText(cookieHeader)?.split(/;\s*/) || []) {
            const separatorIndex = cookiePair.indexOf('=');
            if (separatorIndex > 0) cookies.set(cookiePair.slice(0, separatorIndex), cookiePair.slice(separatorIndex + 1));
        }
    }
    return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

function extractCookiesFromHeaders(headers) {
    if (!headers) return undefined;
    const rawSetCookie = [];
    try {
        if (typeof headers.getSetCookie === 'function') {
            rawSetCookie.push(...headers.getSetCookie());
        }
        if (!rawSetCookie.length && typeof headers.forEach === 'function') {
            headers.forEach((value, key) => {
                if (String(key).toLowerCase() === 'set-cookie') rawSetCookie.push(value);
            });
        }
        if (!rawSetCookie.length && typeof headers === 'object') {
            const raw = headers['set-cookie'] || headers['Set-Cookie'];
            if (Array.isArray(raw)) rawSetCookie.push(...raw);
            else if (typeof raw === 'string') rawSetCookie.push(raw);
        }
    } catch {
        // Ignore malformed header containers.
    }

    const cookieParts = rawSetCookie
        .map((cookie) => cleanText(String(cookie).split(';')[0]))
        .filter(Boolean);

    return cookieParts.length ? cookieParts.join('; ') : undefined;
}

function getHeaderValue(headers, name) {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') return cleanText(headers.get(name));
    return cleanText(headers[name] || headers[name.toLowerCase()]);
}

function getCookieValue(cookieHeader, name) {
    const target = cleanText(name);
    if (!cookieHeader || !target) return undefined;

    for (const part of String(cookieHeader).split(';').map((entry) => entry.trim()).filter(Boolean)) {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex === -1) continue;
        if (part.slice(0, separatorIndex) === target) return part.slice(separatorIndex + 1);
    }

    return undefined;
}

function getWarmupProfile(attempt = 1) {
    return WARMUP_PROFILES[(Math.max(1, attempt) - 1) % WARMUP_PROFILES.length];
}

function getImpit(proxyUrl, browser = 'chrome') {
    const key = `${browser}:${proxyUrl || '__direct__'}`;
    if (impitInstances.has(key)) return impitInstances.get(key);

    const impit = new Impit({
        browser,
        ignoreTlsErrors: true,
        ...(proxyUrl && { proxyUrl }),
    });
    impitInstances.set(key, impit);
    return impit;
}

async function makeImpitRequest({ url, method = 'GET', headers, body, proxyUrl, timeout = 60_000, browser = 'chrome' }) {
    const impit = getImpit(proxyUrl, browser);
    const init = {
        method,
        headers,
        signal: AbortSignal.timeout(timeout),
    };
    if (body !== undefined) init.body = body;

    const response = await impit.fetch(url, init);
    const bodyText = await response.text().catch(() => '');

    return {
        statusCode: response.status,
        url: response.url || url,
        headers: response.headers,
        body: bodyText,
    };
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
            if (error?.challengeSession || error?.rateLimitedSession) throw error;

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

function normalizeProxyConfigurationInput(proxyInput) {
    if (!proxyInput || typeof proxyInput !== 'object') return proxyInput;

    const normalized = { ...proxyInput };
    if (!Array.isArray(normalized.groups) && Array.isArray(normalized.apifyProxyGroups)) {
        normalized.groups = normalized.apifyProxyGroups;
    }

    return normalized;
}

async function buildProxyStrategies(proxyInput) {
    const strategies = [];
    const usedLabels = new Set();
    const addStrategy = (label, proxyConfiguration) => {
        if (usedLabels.has(label)) return;
        usedLabels.add(label);
        strategies.push({ label, proxyConfiguration });
    };

    let userProxyConfiguration;
    const normalizedProxyInput = normalizeProxyConfigurationInput(proxyInput);
    if (normalizedProxyInput) {
        try {
            userProxyConfiguration = await Actor.createProxyConfiguration(normalizedProxyInput);
            if (userProxyConfiguration) addStrategy('input_proxy_configuration', userProxyConfiguration);
        } catch (error) {
            log.warning('Proxy configuration initialization failed, continuing with fallback strategies.', {
                message: toErrorMessage(error),
            });
        }
    }

    if (!strategies.length) addStrategy('direct_no_proxy', undefined);

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
    const duaid = getCookieValue(cookieHeader, 'DUAID');
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
        clientInfo: normalizeHotelClientInfo(`${applicationName},${applicationVersion},${awsRegion}`),
        pageId: normalizeHotelPageId(pageId),
        searchId,
        productOffersId,
        duaid,
        resultsStartingIndex: resultsStartingIndex ?? 3,
        resultsSize: resultsSize ?? 97,
        ctxViewId: crypto.randomUUID(),
    };
}

function normalizeHotelPageId(value) {
    const pageId = cleanText(value);
    return pageId && pageId !== 'wildcard-challenge-handler' && /^page\.Hotel-Search\b/.test(pageId)
        ? pageId
        : HOTEL_LISTING_PAGE_ID_FALLBACK;
}

function getValidHotelPageId(value) {
    const pageId = cleanText(value);
    return pageId && pageId !== 'wildcard-challenge-handler' && /^page\.Hotel-Search\b/.test(pageId)
        ? pageId
        : undefined;
}

function normalizeHotelClientInfo(value) {
    const raw = cleanText(value);
    if (!raw || /captcha|challenge/i.test(raw)) return HOTEL_LISTING_CLIENT_INFO_FALLBACK;

    const parts = raw.split(',').map((part) => cleanText(part)).filter(Boolean);
    if (parts.length >= 3) return parts.slice(0, 3).join(',');
    if (parts.length >= 2) return `${parts[0]},${parts[1]},us-east-1`;
    return HOTEL_LISTING_CLIENT_INFO_FALLBACK;
}

function getValidHotelClientInfo(value) {
    const raw = cleanText(value);
    if (!raw || /captcha|challenge/i.test(raw)) return undefined;

    const parts = raw.split(',').map((part) => cleanText(part)).filter(Boolean);
    if (parts.length >= 3) return parts.slice(0, 3).join(',');
    if (parts.length >= 2) return `${parts[0]},${parts[1]},us-east-1`;
    return undefined;
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

function buildWarmupHeaders({ referer, profile = WARMUP_PROFILES[0] } = {}) {
    return {
        'user-agent': IOS_SAFARI_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-site': referer ? 'same-origin' : 'none',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-user': '?1',
        'sec-fetch-dest': 'document',
        'client-info': 'domain-redirect:true',
        ...profile.extraHeaders,
        ...(referer ? { referer } : {}),
    };
}

function buildGraphqlHeaders({ searchUrl, cookieHeader, bootstrapData }) {
    return {
        'user-agent': IOS_SAFARI_USER_AGENT,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate',
        'content-type': 'application/json',
        'client-info': bootstrapData.clientInfo,
        'device-user-agent-id': bootstrapData.duaid,
        'x-page-id': bootstrapData.pageId,
        'x-enable-apq': 'true',
        'x-shopping-product-line': 'lodging',
        'ctx-view-id': bootstrapData.ctxViewId,
        origin: 'https://www.expedia.com',
        referer: searchUrl,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
    };
}

async function fetchSearchPage({ searchUrl, proxyUrl, profile }) {
    const homeResponse = await makeImpitRequest({
        url: HOME_URL,
        method: 'GET',
        headers: buildWarmupHeaders({ profile }),
        proxyUrl,
        timeout: 30_000,
        browser: profile.browser,
    });
    const homePageId = getHeaderValue(homeResponse.headers, 'x-page-id');
    const homeIsChallenge = homeResponse.statusCode === 429 && homePageId === 'wildcard-challenge-handler';
    if (homeIsChallenge) {
        const error = createHttpStatusError('Expedia homepage warmup returned a 429 wildcard challenge session.', 429);
        error.challengeSession = true;
        throw error;
    }

    let cookieHeader = extractCookiesFromHeaders(homeResponse.headers);

    const listingResponse = await makeImpitRequest({
        url: searchUrl,
        method: 'GET',
        headers: {
            ...buildWarmupHeaders({ referer: HOME_URL, profile }),
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        proxyUrl,
        timeout: 30_000,
        browser: profile.browser,
    });
    const listingPageId = getHeaderValue(listingResponse.headers, 'x-page-id');
    const listingIsChallenge = listingResponse.statusCode === 429 && listingPageId === 'wildcard-challenge-handler';
    if (listingIsChallenge) {
        const error = createHttpStatusError('Expedia hotel listing warmup returned a 429 wildcard challenge session.', 429);
        error.challengeSession = true;
        throw error;
    }

    cookieHeader = mergeCookieHeaderStrings(cookieHeader, extractCookiesFromHeaders(listingResponse.headers));

    log.info('Expedia hotel warmup completed', {
        homeStatusCode: homeResponse.statusCode,
        listingStatusCode: listingResponse.statusCode,
        hasCookies: Boolean(cookieHeader),
    });

    const hasValidListingResponse = listingResponse.statusCode >= 200
        && listingResponse.statusCode < 400
        && listingPageId !== 'wildcard-challenge-handler'
        && Boolean(cookieHeader);
    if (!hasValidListingResponse) {
        throw createHttpStatusError(`Search page request failed with status ${listingResponse.statusCode}`, listingResponse.statusCode);
    }

    listingResponse.cookieHeader = cookieHeader;
    listingResponse.headerPageId = getValidHotelPageId(listingPageId);
    listingResponse.headerClientInfo = getValidHotelClientInfo(getHeaderValue(listingResponse.headers, 'x-app-info'));
    return listingResponse;
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
    const suppressedFailures = [];
    let lastHadProxy = false;

    for (const strategy of proxyStrategies) {
        const hasProxy = Boolean(strategy.proxyConfiguration);
        const maxAttempts = hasProxy ? BOOTSTRAP_MAX_ATTEMPTS_WITH_PROXY : BOOTSTRAP_MAX_ATTEMPTS_WITHOUT_PROXY;
        lastHadProxy = hasProxy;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const profile = getWarmupProfile(attempt);
            let proxyUrl;

            if (strategy.proxyConfiguration) {
                try {
                    const sessionId = `expedia_${crypto.randomUUID().replace(/-/g, '')}`;
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

            log.info('Expedia hotel warmup attempt', {
                attempt,
                maxAttempts,
                profile: profile.name,
                usingProxy: Boolean(proxyUrl),
            });

            for (const [candidateIndex, searchUrl] of searchUrlCandidates.entries()) {
                try {
                    const pageResponse = await fetchSearchPage({ searchUrl, proxyUrl, profile });
                    const { cookieHeader } = pageResponse;
                    const html = String(pageResponse.body || '');
                    const bootstrapData = buildBootstrapData(html, cookieHeader);
                    bootstrapData.pageId = pageResponse.headerPageId || bootstrapData.pageId;
                    bootstrapData.clientInfo = pageResponse.headerClientInfo || bootstrapData.clientInfo;

                    if (suppressedFailures.length) {
                        log.info('Recovered Expedia bootstrap session after rotating proxy/profile.', {
                            suppressedFailures: suppressedFailures.length,
                            proxyStrategy: strategy.label,
                            warmupProfile: profile.name,
                        });
                    }

                    return {
                        pageResponse,
                        searchUrl,
                        proxyUrl,
                        warmupProfile: profile.name,
                        browser: profile.browser,
                        cookieHeader,
                        bootstrapData,
                        proxyStrategy: strategy.label,
                    };
                } catch (error) {
                    lastError = error;
                    const statusCode = getErrorStatusCode(error);
                    const retryable = isBootstrapRetryableError(error);
                    const skipRemainingSearchUrls = shouldSkipRemainingSearchUrls(error) && candidateIndex < searchUrlCandidates.length - 1;
                    suppressedFailures.push({
                        strategy: strategy.label,
                        profile: profile.name,
                        attempt,
                        statusCode,
                        message: toErrorMessage(error),
                    });

                    if (retryable) {
                        if (candidateIndex === searchUrlCandidates.length - 1) {
                            await sleep(getBootstrapBackoffMs({ attempt, statusCode }));
                        }
                    } else {
                        log.warning('Bootstrap failed with non-retryable error.', {
                            strategy: strategy.label,
                            attempt,
                            profile: profile.name,
                            statusCode,
                            message: toErrorMessage(error),
                        });
                    }

                    if (skipRemainingSearchUrls) {
                        break;
                    }
                }
            }
        }
    }

    const statusCode = getErrorStatusCode(lastError);
    if (suppressedFailures.length) {
        log.warning('Expedia bootstrap failed after rotating all proxy/profile candidates.', {
            suppressedFailures: suppressedFailures.length,
            lastStatusCode: statusCode,
            lastMessage: toErrorMessage(lastError),
        });
    }

    if (statusCode === 429) {
        const message = lastHadProxy
            ? `Could not initialize Expedia search session from startUrl. Expedia returned anti-bot 429/challenge responses after ${BOOTSTRAP_MAX_ATTEMPTS_WITH_PROXY} residential warmup attempts.`
            : 'Could not initialize Expedia search session from startUrl. Expedia challenged the direct session. Enable Apify residential proxy in proxyConfiguration and retry.';
        const error = new Error(message);
        error.statusCode = 429;
        error.isExpectedBlocking = true;
        error.shouldFailActor = lastHadProxy;
        throw error;
    }

    throw new Error(`Could not initialize Expedia search session from startUrl. ${lastError?.message || ''}`.trim());
}

async function fetchListingBatch({ graphQlUrl, searchUrl, proxyUrl, browser, cookieHeader, bootstrapData, payload, cookieState }) {
    return retryWithBackoff(async () => {
        const response = await makeImpitRequest({
            url: graphQlUrl,
            method: 'POST',
            headers: buildGraphqlHeaders({ searchUrl, cookieHeader, bootstrapData }),
            body: JSON.stringify([payload]),
            proxyUrl,
            browser,
            timeout: 45_000,
        });

        if (response.statusCode === 429 && getHeaderValue(response.headers, 'x-page-id') === 'wildcard-challenge-handler') {
            const error = createHttpStatusError('PropertyListingQuery received a 429 wildcard challenge session.', 429);
            error.challengeSession = true;
            throw error;
        }

        if (response.statusCode === 429) {
            const error = createHttpStatusError('PropertyListingQuery received a 429 response; rotating the warmed Expedia session.', 429);
            error.rateLimitedSession = true;
            throw error;
        }

        const newCookies = extractCookiesFromHeaders(response.headers);
        if (cookieState && newCookies) {
            // eslint-disable-next-line no-param-reassign
            cookieState.cookieHeader = mergeCookieHeaderStrings(cookieState.cookieHeader, newCookies);
        }

        if (response.statusCode < 200 || response.statusCode >= 400) {
            const error = new Error(`PropertyListingQuery failed with status ${response.statusCode}`);
            error.statusCode = response.statusCode;
            throw error;
        }

        let responseJson;
        try {
            responseJson = JSON.parse(response.body);
        } catch {
            throw new Error('PropertyListingQuery returned a non-JSON response.');
        }

        const result = Array.isArray(responseJson) ? responseJson[0] : responseJson;
        const hasErrors = Array.isArray(result?.errors) && result.errors.length;
        if (hasErrors) {
            const messages = result.errors.map((entry) => entry.message).filter(Boolean);
            const isFatal = messages.some((m) => /persistedquerynotfound|not found|unauthorized|forbidden/i.test(m));
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

    const effectiveProxyInput = proxyInput ?? schemaDefaults.proxyConfiguration;
    const proxyStrategies = await buildProxyStrategies(effectiveProxyInput);
    const [primaryProxyStrategy, ...fallbackProxyStrategies] = proxyStrategies.map((entry) => entry.label);
    log.info('Prepared proxy strategy.', {
        primary: primaryProxyStrategy,
        fallbacks: fallbackProxyStrategies,
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
        warmupProfile: searchSession.warmupProfile,
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
                browser: searchSession.browser,
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
                browser: searchSession.browser,
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

        const pageRecords = [];
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
                pageRecords.push(record);
            } catch (error) {
                log.warning('Skipped hotel card due to processing error.', {
                    hotelId: cleanText(card?.id),
                    message: toErrorMessage(error),
                });
            }
        }

        if (pageRecords.length) {
            await Dataset.pushData(pageRecords);
        }

        log.info(`Saved ${records.length}/${resultsWanted} hotel listings after page ${pageNumber}`, {
            batchSaved: pageRecords.length,
        });

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

    log.info('Finished successfully', {
        saved: records.length,
        requested: resultsWanted,
    });
}

try {
    await main();
    await Actor.exit();
} catch (error) {
    if (error?.isExpectedBlocking) {
        log.error(error.message);
        await Actor.setStatusMessage(error.message);
        if (error.shouldFailActor) {
            await Actor.fail(error.message);
        } else {
            await Actor.exit();
        }
    } else {
        log.exception(error, 'Actor failed');
        await Actor.fail(error.message);
    }
}
