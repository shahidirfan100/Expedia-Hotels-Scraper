import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { Dataset, gotScraping } from 'crawlee';

await Actor.init();

const PROPERTY_LISTING_QUERY = {
    operationName: 'PropertyListingQuery',
    hash: '82abb7da6738db4c904e4d10130072236a751b5a315f6dfaf92474793597bc33',
};

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0',
];

const EXPEDIA_HOST_PATTERN = /(^|\.)expedia\.[a-z.]+$/i;
const DEFAULT_STAY_OFFSET_DAYS = 30;
const DEFAULT_STAY_LENGTH_DAYS = 1;

function randomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

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

    addCandidate(parsed.rawUrl || startUrl);
    addCandidate(buildCanonicalSearchUrl(parsed));

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

        return {
            startUrl: normalizeUrlInput(getSchemaFieldValue(properties.startUrl)),
            results_wanted: toInteger(getSchemaFieldValue(properties.results_wanted)),
            max_pages: toInteger(getSchemaFieldValue(properties.max_pages)),
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
        if (attribute?.name !== 'product_list') continue;

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
    const items = result?.extensions?.analytics?.[0]?.tealiumUtagData?.entity?.hotels?.results?.results || [];
    const analyticsMap = new Map();

    for (const item of items) {
        const hotelId = cleanText(item?.hotelId);
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

async function fetchSearchPage({ searchUrl, userAgent, proxyUrl }) {
    const response = await gotScraping({
        url: searchUrl,
        headers: {
            'user-agent': userAgent,
            'accept-language': 'en-US,en;q=0.9',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        proxyUrl,
        retry: { limit: 0 },
        timeout: { request: 60000 },
        throwHttpErrors: false,
    });

    if (response.statusCode < 200 || response.statusCode >= 400) {
        throw new Error(`Search page request failed with status ${response.statusCode}`);
    }

    return response;
}

async function bootstrapSearchSession({ searchUrlCandidates, proxyConfiguration }) {
    let lastError;
    const maxAttempts = proxyConfiguration ? 3 : 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const userAgent = randomUserAgent();
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

        for (const searchUrl of searchUrlCandidates) {
            try {
                const pageResponse = await fetchSearchPage({ searchUrl, userAgent, proxyUrl });
                const html = String(pageResponse.body || '');
                const cookieHeader = parseCookieHeader(pageResponse.headers['set-cookie'] || []);
                const bootstrapData = buildBootstrapData(html, cookieHeader);

                return {
                    pageResponse,
                    searchUrl,
                    userAgent,
                    proxyUrl,
                    cookieHeader,
                    bootstrapData,
                };
            } catch (error) {
                lastError = error;
                log.warning('Search session bootstrap failed, retrying with next recovery path.', {
                    attempt,
                    searchUrl,
                    message: error.message,
                });
            }
        }
    }

    throw new Error(`Could not initialize Expedia search session from startUrl. ${lastError?.message || ''}`.trim());
}

async function fetchListingBatch({ graphQlUrl, searchUrl, userAgent, proxyUrl, cookieHeader, bootstrapData, payload }) {
    const response = await gotScraping({
        url: graphQlUrl,
        method: 'POST',
        headers: {
            'user-agent': userAgent,
            accept: '*/*',
            'accept-language': 'en-US',
            'content-type': 'application/json',
            'client-info': bootstrapData.clientInfo,
            'x-page-id': bootstrapData.pageId,
            'x-enable-apq': 'true',
            'x-shopping-product-line': 'lodging',
            'ctx-view-id': crypto.randomUUID(),
            origin: 'https://www.expedia.com',
            referer: searchUrl,
            cookie: cookieHeader,
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
        },
        json: [payload],
        responseType: 'json',
        proxyUrl,
        retry: { limit: 0 },
        timeout: { request: 60000 },
        throwHttpErrors: false,
    });

    if (response.statusCode < 200 || response.statusCode >= 400) {
        const errorBody = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
        throw new Error(`PropertyListingQuery failed with status ${response.statusCode}: ${errorBody.slice(0, 300)}`);
    }

    const result = Array.isArray(response.body) ? response.body[0] : response.body;
    if (Array.isArray(result?.errors) && result.errors.length) {
        throw new Error(result.errors.map((entry) => entry.message).filter(Boolean).join('; '));
    }

    return result;
}

async function main() {
    const input = await loadInput();
    const schemaDefaults = await loadInputSchemaDefaults();
    const {
        startUrl: startUrlRaw,
        results_wanted: resultsWantedRaw,
        max_pages: maxPagesRaw,
        proxyConfiguration: proxyInput,
    } = input;
    const startUrl = normalizeUrlInput(startUrlRaw ?? schemaDefaults.startUrl);
    if (!startUrl) {
        throw new Error('Missing startUrl. Provide an Expedia Hotel-Search URL or Expedia destination/listing URL.');
    }

    const resultsWantedSource = resultsWantedRaw ?? schemaDefaults.results_wanted;
    const maxPagesSource = maxPagesRaw ?? schemaDefaults.max_pages;
    const resultsWanted = Number.isFinite(+resultsWantedSource) ? Math.max(1, Math.min(500, +resultsWantedSource)) : 20;
    const maxPages = Number.isFinite(+maxPagesSource) ? Math.max(1, Math.min(50, +maxPagesSource)) : 8;
    const searchUrlCandidates = buildSearchUrlCandidates(startUrl);
    if (!searchUrlCandidates.length) {
        throw new Error('Could not normalize startUrl into a valid Expedia URL.');
    }

    let proxyConfiguration;
    if (proxyInput) {
        try {
            proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
        } catch (error) {
            log.warning('Proxy configuration initialization failed, continuing without proxy', {
                message: error.message,
            });
        }
    }
    const scrapedAt = new Date().toISOString();

    let searchSession = await bootstrapSearchSession({ searchUrlCandidates, proxyConfiguration });
    let normalizedInput = resolveNormalizedSearchInput(
        parseStartUrlSearchInput(searchSession.pageResponse.url || searchSession.searchUrl),
        parseStartUrlSearchInput(searchSession.searchUrl),
        parseStartUrlSearchInput(startUrl),
    );
    let graphQlUrl = new URL('/graphql', searchSession.pageResponse.url || searchSession.searchUrl).toString();

    log.info('Starting Expedia hotel listing extraction', {
        startUrl,
        searchUrl: normalizedInput.startUrl,
        recoveryCandidates: searchUrlCandidates.length,
        operationName: PROPERTY_LISTING_QUERY.operationName,
        operationHash: PROPERTY_LISTING_QUERY.hash,
        resultsWanted,
        maxPages,
        usingProxy: Boolean(searchSession.proxyUrl),
    });

    const seenHotelIds = new Set();
    const records = [];
    let startIndex = searchSession.bootstrapData.resultsStartingIndex;
    const batchSize = searchSession.bootstrapData.resultsSize;

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
                userAgent: searchSession.userAgent,
                proxyUrl: searchSession.proxyUrl,
                cookieHeader: searchSession.cookieHeader,
                bootstrapData: searchSession.bootstrapData,
                payload,
            });
        } catch (error) {
            log.warning('Listing batch failed, refreshing the search session before retrying once.', {
                pageNumber,
                startIndex,
                message: error.message,
            });

            searchSession = await bootstrapSearchSession({
                searchUrlCandidates: [normalizedInput.startUrl, ...searchUrlCandidates],
                proxyConfiguration,
            });
            normalizedInput = resolveNormalizedSearchInput(
                parseStartUrlSearchInput(searchSession.pageResponse.url || searchSession.searchUrl),
                parseStartUrlSearchInput(normalizedInput.startUrl),
                parseStartUrlSearchInput(startUrl),
            );
            graphQlUrl = new URL('/graphql', searchSession.pageResponse.url || searchSession.searchUrl).toString();
            payload = buildRequestPayload({
                input: normalizedInput,
                bootstrapData: searchSession.bootstrapData,
                startIndex,
                size: batchSize,
            });
            result = await fetchListingBatch({
                graphQlUrl,
                searchUrl: searchSession.pageResponse.url || searchSession.searchUrl,
                userAgent: searchSession.userAgent,
                proxyUrl: searchSession.proxyUrl,
                cookieHeader: searchSession.cookieHeader,
                bootstrapData: searchSession.bootstrapData,
                payload,
            });
        }

        const { criteria } = payload.variables;
        const analyticsMap = buildAnalyticsMap(result);
        const cards = (result?.data?.propertySearch?.propertySearchListings || []).filter((entry) => Reflect.get(entry || {}, '__typename') === 'LodgingCard');

        if (!cards.length) break;

        for (const card of cards) {
            if (records.length >= resultsWanted) break;

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
        }

        log.info(`Saved ${records.length}/${resultsWanted} hotel listings after page ${pageNumber}`);

        if (cards.length < batchSize) break;
        startIndex += batchSize;
    }

    if (!records.length) {
        throw new Error('No hotel listings extracted. Verify the Expedia Hotel-Search URL or use residential proxies if the endpoint is blocked.');
    }

    await Dataset.pushData(records);

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
