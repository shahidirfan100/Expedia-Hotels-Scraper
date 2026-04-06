import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { Dataset, gotScraping } from 'crawlee';

await Actor.init();

const GRAPHQL_URL = 'https://www.expedia.com/graphql';
const PROPERTY_LISTING_QUERY = {
    operationName: 'PropertyListingQuery',
    hash: '82abb7da6738db4c904e4d10130072236a751b5a315f6dfaf92474793597bc33',
};

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0',
];

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

function normalizeUrlInput(input) {
    const normalized = cleanText(input);
    if (!normalized) return undefined;

    return normalized
        .replace(/^[\s"'`<[({]+/, '')
        .replace(/[\s"'`>\])}.,;!?]+$/, '');
}

function parseChildrenAges(value) {
    const cleaned = cleanText(value);
    if (!cleaned) return [];

    return cleaned
        .split(',')
        .map((entry) => toInteger(entry))
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

function buildSearchUrl({ startUrl, regionId, destination, checkInDate, checkOutDate, adults, children, sort }) {
    const explicitUrl = normalizeUrlInput(startUrl);
    if (explicitUrl) return explicitUrl;

    const url = new URL('https://www.expedia.com/Hotel-Search');
    if (cleanText(regionId)) url.searchParams.set('regionId', String(regionId));
    if (cleanText(destination)) url.searchParams.set('destination', destination);
    if (adults !== undefined) url.searchParams.set('adults', String(adults));
    if (children !== undefined) url.searchParams.set('children', children);
    if (cleanText(sort)) url.searchParams.set('sort', sort);
    url.searchParams.set('useRewards', 'false');
    url.searchParams.set('vip', 'false');
    if (cleanText(checkInDate)) url.searchParams.set('startDate', checkInDate);
    if (cleanText(checkOutDate)) url.searchParams.set('endDate', checkOutDate);
    return url.toString();
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
            regionId: cleanText(url.searchParams.get('regionId')),
            destination: cleanText(url.searchParams.get('destination')),
            checkInDate: cleanText(url.searchParams.get('startDate')),
            checkOutDate: cleanText(url.searchParams.get('endDate')),
            adults: toInteger(url.searchParams.get('adults')),
            children: cleanText(url.searchParams.get('children')) || '',
            sort: cleanText(url.searchParams.get('sort')),
        };
    } catch {
        return {};
    }
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
            regionId: cleanText(getSchemaFieldValue(properties.regionId)),
            destination: cleanText(getSchemaFieldValue(properties.destination)),
            checkInDate: cleanText(getSchemaFieldValue(properties.checkInDate)),
            checkOutDate: cleanText(getSchemaFieldValue(properties.checkOutDate)),
            adults: toInteger(getSchemaFieldValue(properties.adults)),
            children: cleanText(getSchemaFieldValue(properties.children)) || '',
            sort: cleanText(getSchemaFieldValue(properties.sort)),
            results_wanted: toInteger(getSchemaFieldValue(properties.results_wanted)),
            max_pages: toInteger(getSchemaFieldValue(properties.max_pages)),
        };
    } catch {
        return {};
    }
}

function hasOwnInputValue(input, key) {
    return Object.prototype.hasOwnProperty.call(input, key);
}

function normalizeComparableInputValue(key, value) {
    if (key === 'startUrl') return normalizeUrlInput(value);
    if (key === 'adults' || key === 'results_wanted' || key === 'max_pages') return toInteger(value);
    if (key === 'children') return parseChildrenAges(value).join(',');
    return cleanText(value);
}

function hasCustomInputValue(input, schemaDefaults, key) {
    if (!hasOwnInputValue(input, key)) return false;

    return normalizeComparableInputValue(key, input[key]) !== normalizeComparableInputValue(key, schemaDefaults[key]);
}

function resolveRuntimeSearchInput(input, schemaDefaults) {
    const normalizedStartUrl = normalizeUrlInput(input.startUrl);
    const manualModeKeys = ['regionId', 'destination', 'checkInDate', 'checkOutDate', 'adults', 'children', 'sort'];
    const startUrlSearchInput = parseStartUrlSearchInput(normalizedStartUrl);
    const hasConflictingManualFilters = manualModeKeys.some((key) => {
        if (!hasCustomInputValue(input, schemaDefaults, key)) return false;

        return normalizeComparableInputValue(key, input[key]) !== normalizeComparableInputValue(key, startUrlSearchInput[key]);
    });
    const useStartUrl = Boolean(normalizedStartUrl) && !hasConflictingManualFilters;

    const regionIdChanged = hasCustomInputValue(input, schemaDefaults, 'regionId');
    const destinationChanged = hasCustomInputValue(input, schemaDefaults, 'destination');

    return {
        mode: useStartUrl ? 'startUrl' : 'manualFilters',
        requestInput: {
            startUrl: useStartUrl ? normalizedStartUrl : undefined,
            regionId: destinationChanged && !regionIdChanged
                ? undefined
                : cleanText(input.regionId ?? schemaDefaults.regionId),
            destination: regionIdChanged && !destinationChanged
                ? undefined
                : cleanText(input.destination ?? schemaDefaults.destination),
            checkInDate: cleanText(input.checkInDate ?? schemaDefaults.checkInDate),
            checkOutDate: cleanText(input.checkOutDate ?? schemaDefaults.checkOutDate),
            adults: toInteger(input.adults ?? schemaDefaults.adults) ?? 2,
            children: cleanText(input.children ?? schemaDefaults.children) || '',
            sort: cleanText(input.sort ?? schemaDefaults.sort) || 'RECOMMENDED',
        },
    };
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

async function fetchListingBatch({ searchUrl, userAgent, proxyUrl, cookieHeader, bootstrapData, payload }) {
    const response = await gotScraping({
        url: GRAPHQL_URL,
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
        results_wanted: resultsWantedRaw,
        max_pages: maxPagesRaw,
        proxyConfiguration: proxyInput,
    } = input;

    const { mode, requestInput } = resolveRuntimeSearchInput(input, schemaDefaults);
    const {
        startUrl,
        regionId,
        destination,
        checkInDate,
        checkOutDate,
        adults: adultsRaw,
        children,
        sort,
    } = requestInput;

    const parsedCheckIn = parseDateParts(checkInDate);
    const parsedCheckOut = parseDateParts(checkOutDate);
    if (!normalizeUrlInput(startUrl) && (!parsedCheckIn || !parsedCheckOut)) {
        throw new Error('Missing valid checkInDate/checkOutDate (YYYY-MM-DD) when startUrl is not provided.');
    }

    const resultsWantedSource = resultsWantedRaw ?? schemaDefaults.results_wanted;
    const maxPagesSource = maxPagesRaw ?? schemaDefaults.max_pages;
    const resultsWanted = Number.isFinite(+resultsWantedSource) ? Math.max(1, Math.min(500, +resultsWantedSource)) : 20;
    const maxPages = Number.isFinite(+maxPagesSource) ? Math.max(1, Math.min(50, +maxPagesSource)) : 8;
    const adults = Number.isFinite(+adultsRaw) ? Math.max(1, Math.min(14, Math.trunc(+adultsRaw))) : 2;

    const normalizedInput = {
        startUrl: normalizeUrlInput(startUrl),
        regionId: cleanText(regionId),
        destination: cleanText(destination),
        checkInDate,
        checkOutDate,
        adults,
        children,
        sort: cleanText(sort) || 'RECOMMENDED',
    };

    const searchUrl = buildSearchUrl({
        ...normalizedInput,
        children: parseChildrenAges(children).join(','),
    });

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

    const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
    const userAgent = randomUserAgent();
    const scrapedAt = new Date().toISOString();

    log.info('Starting Expedia hotel listing extraction', {
        searchUrl,
        searchMode: mode,
        operationName: PROPERTY_LISTING_QUERY.operationName,
        operationHash: PROPERTY_LISTING_QUERY.hash,
        resultsWanted,
        maxPages,
        usingProxy: Boolean(proxyUrl),
    });

    const pageResponse = await fetchSearchPage({ searchUrl, userAgent, proxyUrl });
    const html = String(pageResponse.body || '');
    const cookieHeader = parseCookieHeader(pageResponse.headers['set-cookie'] || []);
    const bootstrapData = buildBootstrapData(html, cookieHeader);

    const seenHotelIds = new Set();
    const records = [];
    let startIndex = bootstrapData.resultsStartingIndex;
    const batchSize = bootstrapData.resultsSize;

    for (let pageNumber = 1; pageNumber <= maxPages && records.length < resultsWanted; pageNumber++) {
        const payload = buildRequestPayload({
            input: normalizedInput,
            bootstrapData,
            startIndex,
            size: batchSize,
        });

        const result = await fetchListingBatch({
            searchUrl: pageResponse.url || searchUrl,
            userAgent,
            proxyUrl,
            cookieHeader,
            bootstrapData,
            payload,
        });

        const criteria = payload.variables.criteria;
        const analyticsMap = buildAnalyticsMap(result);
        const cards = (result?.data?.propertySearch?.propertySearchListings || []).filter((entry) => entry?.__typename === 'LodgingCard');

        if (!cards.length) break;

        for (const card of cards) {
            if (records.length >= resultsWanted) break;

            const hotelId = cleanText(card?.id);
            const analyticsItem = hotelId ? analyticsMap.get(hotelId) : undefined;
            const record = normalizeHotelRecord({
                card,
                criteria,
                analyticsItem,
                sourceUrl: GRAPHQL_URL,
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
