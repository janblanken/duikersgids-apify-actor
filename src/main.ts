import { Actor, log } from 'apify';
import { CheerioCrawler, RequestOptions } from 'crawlee';

export interface ActorInput {
    maxItems?: number;
    searchKeyword?: string;
    dateFrom?: string;
    dateTo?: string;
    windowDays?: number;
    spotUrls?: Array<string | { url: string }>;
    scrapeLogDetails?: boolean;
    enrichWithSpotCoordinates?: boolean;
    proxyConfiguration?: Record<string, unknown>;
}

export interface DiveSpotMeta {
    id: string;
    reference: string;
    name: string;
    lat: number | null;
    lng: number | null;
    premium: boolean;
    href: string;
    slug: string;
}

export interface DiveLogRecord {
    logId: string;
    hashLogId: string | null;
    date: string | null;
    dateRaw: string;
    spotName: string;
    spotSlug: string | null;
    stekId: string | null;
    latitude: number | null;
    longitude: number | null;
    countryRegion: string | null;
    diverName: string;
    diverProfileUrl: string | null;
    diverAvatarUrl: string | null;
    ratingStars: number;
    visibilityMeters: number | null;
    waterTemperatureCelsius: number | null;
    temperatureDepthMeters: number | null;
    hasPhoto: boolean;
    photos: string[];
    remarks: string;
    logUrl: string;
    spotUrl: string | null;
    scrapedAt: string;
}

const BASE_URL = 'https://www.duikersgids.nl';
const PAGE_CAP = 100;

/**
 * Parse DD-MM-YYYY string into a UTC Date at 00:00:00.
 */
function parseDdMmYyyy(dateStr: string): Date | null {
    const cleaned = dateStr.trim();
    const match = cleaned.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
    if (!match) return null;
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    let year = parseInt(match[3], 10);
    if (year < 100) {
        year += 2000;
    }
    return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Format Date into DD-MM-YYYY for Duikersgids URLs.
 */
function formatDdMmYyyy(date: Date): string {
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = date.getUTCFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

/**
 * Format Date into YYYY-MM-DD (ISO 8601 date).
 */
function formatIsoDate(date: Date): string {
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = date.getUTCFullYear();
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Add days to a UTC Date.
 */
function addDays(date: Date, days: number): Date {
    const next = new Date(date.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
}

/**
 * Parse visibility string like "6 m" or "6m" into number.
 */
function parseMeters(text: string): number | null {
    const match = text.replace(',', '.').match(/(-?\d+(?:\.\d+)?)\s*m/i);
    return match ? parseFloat(match[1]) : null;
}

/**
 * Parse temperature & depth string like "11 °C - 17 m" into { tempC, depthM }.
 */
function parseTempAndDepth(text: string): { tempC: number | null; depthM: number | null } {
    const tempMatch = text.replace(',', '.').match(/(-?\d+(?:\.\d+)?)\s*(?:°|&deg;)?\s*C/i);
    const depthMatch = text.replace(',', '.').match(/-\s*(\d+(?:\.\d+)?)\s*m/i)
        || text.replace(',', '.').match(/(\d+(?:\.\d+)?)\s*m/i);
    return {
        tempC: tempMatch ? parseFloat(tempMatch[1]) : null,
        depthM: depthMatch ? parseFloat(depthMatch[1]) : null,
    };
}

/**
 * Extract slug from a Duikersgids spot or log URL.
 */
function extractSpotSlugFromLogUrl(logUrl: string): string | null {
    const match = logUrl.match(/\/logbericht\/([^/]+)\/([^/]+)\//);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Fetch all dive spots from Duikersgids JSON endpoint for fast coordinate & stekId enrichment.
 */
async function fetchDiveSpotsDirectory(): Promise<{
    bySlug: Map<string, DiveSpotMeta>;
    byName: Map<string, DiveSpotMeta>;
}> {
    const bySlug = new Map<string, DiveSpotMeta>();
    const byName = new Map<string, DiveSpotMeta>();

    try {
        const res = await fetch(`${BASE_URL}/index.php?route=module/duikersgids/getDiveSpots`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (compatible; DuikersgidsApifyActor/1.0)',
            },
            body: 'basedata=',
        });

        if (!res.ok) {
            log.warning(`getDiveSpots returned HTTP ${res.status}`);
            return { bySlug, byName };
        }

        const rawSpots = (await res.json()) as Array<{
            id: string;
            reference: string;
            name: string;
            lat: string;
            lng: string;
            premium: string;
            href: string;
        }>;

        for (const s of rawSpots) {
            const cleanHref = s.href.replace(/\\\//g, '/');
            const slugMatch = cleanHref.match(/\/([^/]+)$/);
            const slug = slugMatch ? slugMatch[1].toLowerCase() : s.name.toLowerCase().replace(/\s+/g, '-');
            const lat = parseFloat(s.lat);
            const lng = parseFloat(s.lng);

            const meta: DiveSpotMeta = {
                id: String(s.id),
                reference: s.reference,
                name: s.name.trim(),
                lat: Number.isFinite(lat) ? lat : null,
                lng: Number.isFinite(lng) ? lng : null,
                premium: s.premium === '1',
                href: cleanHref.replace('/duikstekken/', '/'),
                slug,
            };

            bySlug.set(slug, meta);
            byName.set(s.name.trim().toUpperCase(), meta);
        }

        log.info(`Loaded ${rawSpots.length} dive spots from Duikersgids directory for GPS enrichment.`);
    } catch (err) {
        log.warning(`Could not load dive spots directory: ${(err as Error).message}`);
    }

    return { bySlug, byName };
}

/**
 * Build a /logberichten search URL for a keyword and [fromDate, toDate] window.
 * Note: Duikersgids requires >= 3 characters in the keyword segment; '%25%25%25' ('%%%')
 * acts as a universal wildcard matching all dive logs chronologically.
 */
function buildLogSearchUrl(keyword: string, fromDate: Date, toDate: Date): string {
    const cleanKeyword = keyword.trim();
    const encodedKeyword = cleanKeyword.length >= 3 ? encodeURIComponent(cleanKeyword) : '%25%25%25';
    const fromStr = formatDdMmYyyy(fromDate);
    const toStr = formatDdMmYyyy(toDate);
    return `${BASE_URL}/logberichten/${encodedKeyword}/${fromStr}/${toStr}`;
}

await Actor.init();

const input = (await Actor.getInput<ActorInput>()) ?? {};
const {
    maxItems = 200,
    searchKeyword = '',
    dateFrom = '',
    dateTo = '',
    windowDays = 7,
    spotUrls = [],
    scrapeLogDetails = false,
    enrichWithSpotCoordinates = true,
    proxyConfiguration: proxyConfigInput,
} = input;

const proxyConfiguration = proxyConfigInput
    ? await Actor.createProxyConfiguration(proxyConfigInput)
    : undefined;

const spotDirectory = enrichWithSpotCoordinates
    ? await fetchDiveSpotsDirectory()
    : { bySlug: new Map<string, DiveSpotMeta>(), byName: new Map<string, DiveSpotMeta>() };

const now = new Date();
const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const parsedEndDate = dateTo ? parseDdMmYyyy(dateTo) : todayUtc;
const parsedStartDate = dateFrom ? parseDdMmYyyy(dateFrom) : addDays(todayUtc, -365);

if (!parsedEndDate || !parsedStartDate) {
    throw new Error('Invalid dateFrom or dateTo format. Expected DD-MM-YYYY (e.g., "01-01-2026").');
}

const seenLogIds = new Set<string>();
let savedCount = 0;
let enqueuedCount = 0;

function hasReachedLimit(): boolean {
    return maxItems > 0 && savedCount >= maxItems;
}

function hasReachedEnqueueLimit(): boolean {
    return maxItems > 0 && enqueuedCount >= maxItems;
}

/**
 * Enrich a partial DiveLogRecord using the cached dive spots directory.
 */
function enrichLogWithSpot(record: DiveLogRecord): DiveLogRecord {
    const spotMeta = (record.spotSlug ? spotDirectory.bySlug.get(record.spotSlug) : undefined)
        ?? spotDirectory.byName.get(record.spotName.toUpperCase());

    if (spotMeta) {
        record.stekId = record.stekId ?? spotMeta.id;
        record.latitude = record.latitude ?? spotMeta.lat;
        record.longitude = record.longitude ?? spotMeta.lng;
        record.spotUrl = record.spotUrl ?? spotMeta.href;
        record.spotSlug = record.spotSlug ?? spotMeta.slug;
    } else if (record.spotSlug && !record.spotUrl) {
        record.spotUrl = `${BASE_URL}/${record.spotSlug}`;
    }

    return record;
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 5,
    async requestHandler({ $, request, crawler: activeCrawler }) {
        if (hasReachedLimit()) return;

        const label = request.userData.label as 'LOG_SEARCH' | 'SPOT_PAGE' | 'LOG_DETAIL';

        if (label === 'LOG_SEARCH') {
            const winStartIso = request.userData.winStartIso as string;
            const winEndIso = request.userData.winEndIso as string;
            const winStart = new Date(winStartIso);
            const winEnd = new Date(winEndIso);

            const articles = $('.gridlog article.item').toArray();
            log.info(`Fetched ${articles.length} logs from ${request.url}`);

            // If we hit the 100-item page cap and the window spans multiple days,
            // split the date window into two halves so we don't miss logs in busy periods!
            const spanDays = Math.round((winEnd.getTime() - winStart.getTime()) / (1000 * 60 * 60 * 24));
            if (articles.length >= PAGE_CAP && spanDays >= 1) {
                const midDays = Math.floor(spanDays / 2);
                const midDate = addDays(winStart, midDays);
                const secondHalfStart = addDays(midDate, 1);

                log.info(
                    `Window ${formatDdMmYyyy(winStart)}..${formatDdMmYyyy(winEnd)} hit ${PAGE_CAP} logs cap; splitting into finer windows.`,
                );

                // Enqueue the newer half first, then the older half
                const subRequests: RequestOptions[] = [
                    {
                        url: buildLogSearchUrl(searchKeyword, secondHalfStart, winEnd),
                        uniqueKey: `SEARCH_${secondHalfStart.toISOString()}_${winEnd.toISOString()}`,
                        userData: {
                            label: 'LOG_SEARCH',
                            winStartIso: secondHalfStart.toISOString(),
                            winEndIso: winEnd.toISOString(),
                            isSplitWindow: true,
                            nextCursorIso: request.userData.nextCursorIso,
                        },
                    },
                    {
                        url: buildLogSearchUrl(searchKeyword, winStart, midDate),
                        uniqueKey: `SEARCH_${winStart.toISOString()}_${midDate.toISOString()}`,
                        userData: {
                            label: 'LOG_SEARCH',
                            winStartIso: winStart.toISOString(),
                            winEndIso: midDate.toISOString(),
                            isSplitWindow: Boolean(request.userData.isSplitWindow),
                            nextCursorIso: request.userData.nextCursorIso,
                        },
                    },
                ];
                await activeCrawler.addRequests(subRequests);
                return;
            }

            const detailRequests: RequestOptions[] = [];
            const recordsToPush: DiveLogRecord[] = [];

            for (const el of articles) {
                if (hasReachedEnqueueLimit()) break;

                const $el = $(el);
                const logUrl = ($el.attr('data-url') || $el.find('a.goto').attr('href') || '').trim();
                const classAttr = $el.attr('class') || '';
                const idMatch = classAttr.match(/\blog-([A-Za-z0-9]+)\b/) || logUrl.match(/\/logbericht\/[^/]+\/([^/]+)\//);
                const logId = idMatch ? idMatch[1] : logUrl;

                if (!logId || seenLogIds.has(logId)) continue;
                seenLogIds.add(logId);

                const diverName = $el.find('header .name').text().trim();
                const spotName = $el.find('header .spotname').text().trim();
                const dateRaw = $el.find('header .date').text().trim();
                const parsedDate = parseDdMmYyyy(dateRaw);
                const dateIso = parsedDate ? formatIsoDate(parsedDate) : null;

                const $outputClone = $el.find('.output p').clone();
                $outputClone.find('a.goto').remove();
                const remarks = $outputClone.text().replace(/\s+/g, ' ').trim();

                const ratingStars = $el.find('.circle-votes .icon-star').length;
                const visText = $el.find('.item.visible .text').text().trim();
                const tempText = $el.find('.item.temperature .text').text().trim();
                const visibilityMeters = parseMeters(visText);
                const { tempC, depthM } = parseTempAndDepth(tempText);
                const hasPhoto = $el.find('.item.hasimage').length > 0;
                const spotSlug = extractSpotSlugFromLogUrl(logUrl);

                const record = enrichLogWithSpot({
                    logId,
                    hashLogId: /^\d+$/.test(logId) ? null : logId,
                    date: dateIso,
                    dateRaw,
                    spotName,
                    spotSlug,
                    stekId: null,
                    latitude: null,
                    longitude: null,
                    countryRegion: null,
                    diverName,
                    diverProfileUrl: null,
                    diverAvatarUrl: null,
                    ratingStars,
                    visibilityMeters,
                    waterTemperatureCelsius: tempC,
                    temperatureDepthMeters: depthM,
                    hasPhoto,
                    photos: [],
                    remarks,
                    logUrl,
                    spotUrl: null,
                    scrapedAt: new Date().toISOString(),
                });

                enqueuedCount++;
                if (scrapeLogDetails && logUrl) {
                    detailRequests.push({
                        url: logUrl,
                        uniqueKey: `DETAIL_${logId}`,
                        userData: {
                            label: 'LOG_DETAIL',
                            record,
                        },
                    });
                } else {
                    savedCount++;
                    recordsToPush.push(record);
                }
            }

            if (recordsToPush.length > 0) {
                await Actor.pushData(recordsToPush);
                log.info(`Saved ${recordsToPush.length} logs (total: ${savedCount}/${maxItems || '∞'})`);
            }

            if (detailRequests.length > 0) {
                await activeCrawler.addRequests(detailRequests);
            }

            // Enqueue the next historical date window if we haven't reached maxItems or parsedStartDate
            const nextCursorIso = request.userData.nextCursorIso as string | undefined;
            if (!hasReachedEnqueueLimit() && !request.userData.isSplitWindow && nextCursorIso) {
                const nextEnd = new Date(nextCursorIso);
                if (nextEnd >= parsedStartDate) {
                    const candidateStart = addDays(nextEnd, -(windowDays - 1));
                    const nextStart = candidateStart < parsedStartDate ? parsedStartDate : candidateStart;
                    const followingCursor = addDays(nextStart, -1);

                    await activeCrawler.addRequests([
                        {
                            url: buildLogSearchUrl(searchKeyword, nextStart, nextEnd),
                            uniqueKey: `SEARCH_${nextStart.toISOString()}_${nextEnd.toISOString()}`,
                            userData: {
                                label: 'LOG_SEARCH',
                                winStartIso: nextStart.toISOString(),
                                winEndIso: nextEnd.toISOString(),
                                isSplitWindow: false,
                                nextCursorIso: followingCursor >= parsedStartDate ? followingCursor.toISOString() : undefined,
                            },
                        },
                    ]);
                }
            }
        } else if (label === 'SPOT_PAGE') {
            const logItems = $('.slick-logs .logitem').toArray();
            log.info(`Found ${logItems.length} logs on spot page ${request.url}`);

            const recordsToPush: DiveLogRecord[] = [];
            const detailRequests: RequestOptions[] = [];

            for (const el of logItems) {
                if (hasReachedEnqueueLimit()) break;

                const $el = $(el);
                const logUrl = ($el.attr('data-url') || '').trim();
                const hashLogId = ($el.attr('data-log-id') || '').trim();
                const stekId = ($el.attr('data-stekid') || '').trim() || null;
                const rel = ($el.attr('rel') || '').split(';');
                const lat = rel.length > 1 ? parseFloat(rel[1]) : NaN;
                const lng = rel.length > 2 ? parseFloat(rel[2]) : NaN;

                const logId = hashLogId || logUrl;
                if (!logId || seenLogIds.has(logId)) continue;
                seenLogIds.add(logId);

                const spotName = $el.find('.spotname').text().trim();
                const diverName = (
                    $el.find('.username').text().trim() || $el.find('.log-name-guest').text().trim()
                );
                const avatarAttr = $el.find('.avatar').attr('data-bgimg') || null;
                const diverAvatarUrl = avatarAttr && !avatarAttr.startsWith('data:')
                    ? (avatarAttr.startsWith('http') ? avatarAttr : `${BASE_URL}/${avatarAttr.replace(/^\//, '')}`)
                    : null;

                const countryRegion = $el.find('.country').text().replace(/\s+/g, ' ').trim() || null;
                const dateRaw = $el.find('.date').text().trim();
                const parsedDate = parseDdMmYyyy(dateRaw);
                const dateIso = parsedDate ? formatIsoDate(parsedDate) : null;

                const remarks = $el.find('.log-output').text().replace(/\s+/g, ' ').trim();
                const ratingStars = $el.find('.circle-votes .icon-star').length;
                const visText = $el.find('.item.visible .text').text().trim();
                const tempText = $el.find('.item.temperature .text').text().trim();
                const visibilityMeters = parseMeters(visText);
                const { tempC, depthM } = parseTempAndDepth(tempText);
                const hasPhoto = $el.find('.item.hasimage').length > 0;
                const spotSlug = extractSpotSlugFromLogUrl(logUrl);

                const record = enrichLogWithSpot({
                    logId,
                    hashLogId: hashLogId || null,
                    date: dateIso,
                    dateRaw,
                    spotName,
                    spotSlug,
                    stekId,
                    latitude: Number.isFinite(lat) ? lat : null,
                    longitude: Number.isFinite(lng) ? lng : null,
                    countryRegion,
                    diverName,
                    diverProfileUrl: null,
                    diverAvatarUrl,
                    ratingStars,
                    visibilityMeters,
                    waterTemperatureCelsius: tempC,
                    temperatureDepthMeters: depthM,
                    hasPhoto,
                    photos: [],
                    remarks,
                    logUrl,
                    spotUrl: request.loadedUrl ?? request.url,
                    scrapedAt: new Date().toISOString(),
                });

                enqueuedCount++;
                if (scrapeLogDetails && logUrl) {
                    detailRequests.push({
                        url: logUrl,
                        uniqueKey: `DETAIL_${logId}`,
                        userData: {
                            label: 'LOG_DETAIL',
                            record,
                        },
                    });
                } else {
                    savedCount++;
                    recordsToPush.push(record);
                }
            }

            if (recordsToPush.length > 0) {
                await Actor.pushData(recordsToPush);
                log.info(`Saved ${recordsToPush.length} spot logs (total: ${savedCount}/${maxItems || '∞'})`);
            }

            if (detailRequests.length > 0) {
                await activeCrawler.addRequests(detailRequests);
            }
        } else if (label === 'LOG_DETAIL') {
            if (hasReachedLimit()) return;

            const record = request.userData.record as DiveLogRecord;
            const loadedUrl = request.loadedUrl || request.url;
            const hashMatch = loadedUrl.match(/\/logbericht\/[^/]+\/([^/]+)\//);
            if (hashMatch) {
                record.hashLogId = hashMatch[1];
            }

            const fullRemarks = $('.log-card-lg .log__remarks').text().replace(/\s+/g, ' ').trim();
            if (fullRemarks) {
                record.remarks = fullRemarks;
            }

            const countryRegion = $('.log-card-lg .log__country').text().replace(/\s+/g, ' ').trim();
            if (countryRegion) {
                record.countryRegion = countryRegion;
            }

            const profileHref = $('.log-card-lg .log__user-name a').attr('href');
            if (profileHref) {
                record.diverProfileUrl = profileHref.startsWith('http')
                    ? profileHref
                    : `${BASE_URL}/${profileHref.replace(/^\//, '')}`;
            }

            const avatarBg = $('.log-card-lg .avatar').attr('data-bgimg');
            if (avatarBg && !avatarBg.startsWith('data:')) {
                record.diverAvatarUrl = avatarBg.startsWith('http')
                    ? avatarBg
                    : `${BASE_URL}/${avatarBg.replace(/^\//, '')}`;
            }

            const coordsAttr = $('#stekmap').attr('data-coords');
            if (coordsAttr) {
                const [latStr, lngStr] = coordsAttr.split(';');
                const lat = parseFloat(latStr);
                const lng = parseFloat(lngStr);
                if (Number.isFinite(lat)) record.latitude = lat;
                if (Number.isFinite(lng)) record.longitude = lng;
            }

            const stekIdInput = $('input[name="stek_id"]').attr('value');
            if (stekIdInput) {
                record.stekId = stekIdInput;
            }

            const spotHref = $('.stek-secondary h2.title a').attr('href');
            if (spotHref) {
                record.spotUrl = spotHref.startsWith('http') ? spotHref : `${BASE_URL}/${spotHref.replace(/^\//, '')}`;
            }

            const photos: string[] = [];
            $('.logfoto .slick-images a.zoom').each((_, a) => {
                const href = $(a).attr('href');
                if (href) {
                    photos.push(href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`);
                }
            });
            record.photos = photos;
            if (photos.length > 0) {
                record.hasPhoto = true;
            }
            record.logUrl = loadedUrl;

            savedCount++;
            await Actor.pushData(record);
            log.info(`Saved detailed log ${record.logId} (total: ${savedCount}/${maxItems || '∞'})`);
        }
    },
});

const initialRequests: RequestOptions[] = [];

// 1. Enqueue specific dive spot URLs if provided
for (const entry of spotUrls) {
    const url = typeof entry === 'string' ? entry.trim() : entry?.url?.trim();
    if (url) {
        initialRequests.push({
            url,
            userData: { label: 'SPOT_PAGE' },
        });
    }
}

// 2. If no spotUrls provided, start date-window pagination on /logberichten
if (initialRequests.length === 0) {
    if (maxItems === 0) {
        // Pre-generate all date windows from parsedEndDate down to parsedStartDate for fast concurrent scraping
        let cursorEnd = new Date(parsedEndDate.getTime());
        while (cursorEnd >= parsedStartDate) {
            const candidateStart = addDays(cursorEnd, -(windowDays - 1));
            const winStart = candidateStart < parsedStartDate ? parsedStartDate : candidateStart;
            initialRequests.push({
                url: buildLogSearchUrl(searchKeyword, winStart, cursorEnd),
                uniqueKey: `SEARCH_${winStart.toISOString()}_${cursorEnd.toISOString()}`,
                userData: {
                    label: 'LOG_SEARCH',
                    winStartIso: winStart.toISOString(),
                    winEndIso: cursorEnd.toISOString(),
                    isSplitWindow: false,
                    nextCursorIso: undefined,
                },
            });
            cursorEnd = addDays(winStart, -1);
        }
    } else {
        const firstWinStartCandidate = addDays(parsedEndDate, -(windowDays - 1));
        const firstWinStart = firstWinStartCandidate < parsedStartDate ? parsedStartDate : firstWinStartCandidate;
        const nextCursor = addDays(firstWinStart, -1);

        initialRequests.push({
            url: buildLogSearchUrl(searchKeyword, firstWinStart, parsedEndDate),
            uniqueKey: `SEARCH_${firstWinStart.toISOString()}_${parsedEndDate.toISOString()}`,
            userData: {
                label: 'LOG_SEARCH',
                winStartIso: firstWinStart.toISOString(),
                winEndIso: parsedEndDate.toISOString(),
                isSplitWindow: false,
                nextCursorIso: nextCursor >= parsedStartDate ? nextCursor.toISOString() : undefined,
            },
        });
    }
}

log.info(`Starting Duikersgids Dive Logs Crawler with ${initialRequests.length} initial request(s)...`);
await crawler.run(initialRequests);
log.info(`Finished! Total dive logs scraped: ${savedCount}`);

await Actor.exit();
