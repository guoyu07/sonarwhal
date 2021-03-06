/**
 * @fileoverview Check if resources are served compressed when requested
 * as such using the most appropriate encoding.
 */

/*
 * ------------------------------------------------------------------------------
 * Requirements
 * ------------------------------------------------------------------------------
 */

import * as decompressBrotli from 'brotli/decompress';
import * as mimeDB from 'mime-db';

import { Category } from '../../enums/category';
import { getFileExtension, isTextMediaType } from '../../utils/content-type';
import { getHeaderValueNormalized, isRegularProtocol, isHTTP, normalizeString } from '../../utils/misc';
import { IAsyncHTMLElement, IResponse, IRule, IRuleBuilder, IFetchEnd } from '../../types';
import { RuleContext } from '../../rule-context';
import { CompressionCheckOptions } from './compression-check-options';

const uaString = 'Mozilla/5.0 Gecko';

/*
 * ------------------------------------------------------------------------------
 * Public
 * ------------------------------------------------------------------------------
 */

const rule: IRuleBuilder = {
    create(context: RuleContext): IRule {

        const getRuleOptions = (property: string): CompressionCheckOptions => {
            return Object.assign(
                {},
                {
                    brotli: true,
                    gzip: true,
                    zopfli: true
                },
                (context.ruleOptions && context.ruleOptions[property])
            );
        };

        const resourceOptions: CompressionCheckOptions = getRuleOptions('resource');
        const targetOptions: CompressionCheckOptions = getRuleOptions('target');

        // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

        const checkIfBytesMatch = (rawResponse: Buffer, magicNumbers) => {
            return rawResponse && magicNumbers.every((b, i) => {
                return rawResponse[i] === b;
            });
        };

        const getHeaderValues = (headers, headerName) => {
            return (getHeaderValueNormalized(headers, headerName) || '').split(',');
        };

        const checkVaryHeader = async (resource, element, headers) => {
            const varyHeaderValues = getHeaderValues(headers, 'vary');
            const cacheControlValues = getHeaderValues(headers, 'cache-control');

            if (!cacheControlValues.includes('private') &&
                !varyHeaderValues.includes('accept-encoding')) {
                await context.report(resource, element, `Should be served with the 'Vary' header containing 'Accept-Encoding' value.`);
            }
        };

        const generateDisallowedCompressionMessage = (encoding: string) => {
            return `Disallowed compression method: '${encoding}'.`;
        };

        const generateContentEncodingMessage = (encoding: string, notRequired?: boolean, suffix?: string) => {
            return `Should${notRequired ? ' not' : ''} be served with the 'content-encoding${encoding ? `: ${encoding}` : ''}' header${suffix ? ` ${suffix}` : ''}.`;
        };

        const generateCompressionMessage = (encoding: string, notRequired?: boolean, suffix?: string) => {
            return `Should${notRequired ? ' not' : ''} be served compressed${encoding ? ` with ${encoding}` : ''}${suffix ? ` ${suffix}` : ''}.`;
        };

        const generateSizeMessage = async (resource: string, element: IAsyncHTMLElement, encoding: string, sizeDifference) => {
            await context.report(resource, element, `Should not be served compressed with ${encoding} as the compressed size is ${sizeDifference > 0 ? 'bigger than' : 'the same size as'} the uncompressed one.`);
        };

        const getNetworkData = async (resource: string, requestHeaders) => {
            const networkData = await context.fetchContent(resource, requestHeaders);

            return {
                contentEncodingHeaderValue: getHeaderValueNormalized(networkData.response.headers, 'content-encoding'),
                rawContent: networkData.response.body.rawContent,
                rawResponse: await networkData.response.body.rawResponse(),
                response: networkData.response
            };
        };

        const isCompressedWithBrotli = (rawResponse: Buffer): boolean => {

            /*
             * Brotli doesn't currently contain any magic numbers.
             * https://github.com/google/brotli/issues/298#issuecomment-172549140
             */

            try {
                const decompressedContent = decompressBrotli(rawResponse);

                if (decompressedContent.byteLength === 0 &&
                    rawResponse.byteLength !== 0) {

                    return false;
                }
            } catch (e) {
                return false;
            }

            return true;
        };

        const isCompressedWithGzip = (rawContent: Buffer): boolean => {
            // See: https://tools.ietf.org/html/rfc1952#page-5.
            return checkIfBytesMatch(rawContent, [0x1f, 0x8b]);
        };

        const isNotCompressedWithZopfli = (rawResponse: Buffer): boolean => {

            /*
             * Since the Zopfli output (for the gzip option) is valid
             * gzip content, there doesn't seem to be a straightforward
             * and foolproof way to identify files compressed with Zopfli.
             *
             * - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
             *
             * From an email discussion with @lvandeve:
             *
             * " There is no way to tell for sure. Adding information
             *   to the output to indicate zopfli, would actually
             *   add bits to the output so such thing is not done :)
             *   Any compressor can set the FLG, MTIME, and so on
             *   to anything it wants, and users of zopfli can also
             *   change the MTIME bytes that zopfli had output to an
             *   actual time.
             *
             *   One heuristic to tell that it was compressed with
             *   zopfli or another dense deflate compressor is to
             *   compress it with regular gzip -9 (which is fast),
             *   and compare that the size of the file to test is
             *   for example more than 3% smaller. "
             *
             * Using the above mentioned for every resource `sonarwhal`
             * encounters can be expensive, plus, for the online scanner,
             * it might also cause some security (?) problems.
             *
             * So, since this is not a foolproof way to identify files
             * compressed with Zopfli, the following still not foolproof,
             * but faster way is used.
             *
             * - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
             *
             * 1. gzip
             *
             *    A gzip member header has the following structure
             *
             *     +---+---+---+---+---+---+---+---+---+---+
             *     |ID1|ID2|CM |FLG|     MTIME     |XFL|OS | (more-->)
             *     +---+---+---+---+---+---+---+---+---+---+
             *
             *    where:
             *
             *     ID1 = 1f and ID2 = 8b - these are the magic
             *           numbers that uniquely identify the content
             *           as being gzip.
             *
             *     CM = 8 - this is a value customarily used by gzip
             *
             *     FLG and MTIME are usually non-zero values.
             *
             *     XFL will be either 0, 2, or 4:
             *
             *       0 - default, compressor used intermediate levels
             *           of compression (when any of the -2 ... -8
             *           options are used).
             *
             *       2 - the compressor used maximum compression,
             *           slowest algorithm (when the -9 or --best
             *           option is used).
             *
             *       4 - the compressor used fastest algorithm (when
             *           the -1 or --fast option is used).
             *
             * 2. Zopfli
             *
             *    One thing that Zopfli does is that it sets FLG and
             *    MTIME to 0, XFL to 2, and OS to 3 [1], so basically
             *    files compressed with Zopfli will most likely start
             *    with `1f8b 0800 0000 0000 0203`, unless things are
             *    changed by the user (which in general doesn't seem
             *    very likely to happen).
             *
             *    Now, regular gzip output might also start with that,
             *    even thought the chance of doing so is smaller:
             *
             *    * Most web servers (e.g.: Apache², NGINX³), by default,
             *      will not opt users into the best compression level,
             *      therefore, the output shouldn't have XFL set to 2.
             *
             *    * Most utilities that output regular gzip will have
             *      non-zero values for MTIME and FLG.
             *
             *   So, if a file does not start with:
             *
             *      `1f8b 0800 0000 0000 0203`
             *
             *   it's a good (not perfect) indication that Zopfli wasn't
             *   used, but it's a fast check compared to compressing
             *   files and comparing file sizes. However, if a file does
             *   start with that, it can be either Zopfli or gzip, and
             *   we cannot really make assumptions here.
             *
             * - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
             *
             * Ref:
             *
             *   ¹ https://github.com/google/zopfli/blob/6818a0859063b946094fb6f94732836404a0d89a/src/zopfli/gzip_container.c#L90-L101)
             *   ² https://httpd.apache.org/docs/current/mod/mod_deflate.html#DeflateCompressionLevel
             *   ³ https://nginx.org/en/docs/http/ngx_http_gzip_module.html#gzip_comp_level
             */

            return !checkIfBytesMatch(rawResponse, [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03]);
        };

        const checkBrotli = async (resource, element) => {
            const { contentEncodingHeaderValue, rawResponse, response } = await getNetworkData(resource, { 'Accept-Encoding': 'br' });

            const compressedWithBrotli = isCompressedWithBrotli(rawResponse);

            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

            // Check if compressed with Brotli over HTTP.

            if (isHTTP(resource)) {
                if (compressedWithBrotli) {
                    await context.report(resource, element, generateCompressionMessage('Brotli', true, 'over HTTP'));
                }

                return;
            }

            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

            // Check compressed vs. uncompressed sizes.

            /*
             * TODO: Remove the following once connectors
             *       support Brotli compression.
             */
            const rawContent = compressedWithBrotli ? decompressBrotli(rawResponse) : response.body.rawContent;

            const itShouldNotBeCompressed = contentEncodingHeaderValue === 'br' &&
                rawContent.byteLength <= rawResponse.byteLength;

            if (compressedWithBrotli && itShouldNotBeCompressed) {
                generateSizeMessage(resource, element, 'Brotli', rawResponse.byteLength - rawContent.byteLength);

                return;
            }

            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

            // Check if compressed.

            if (!compressedWithBrotli) {
                await context.report(resource, element, generateCompressionMessage('Brotli', false, 'over HTTPS'));

                return;
            }

            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

            // Check related headers.

            await checkVaryHeader(resource, element, response.headers);

            if (contentEncodingHeaderValue !== 'br') {
                await context.report(resource, element, generateContentEncodingMessage('br'));
            }

            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

            // Check for user agent sniffing.

            const { rawResponse: uaRawResponse } = await getNetworkData(resource, {
                'Accept-Encoding': 'br',
                'User-Agent': uaString
            });

            if (!isCompressedWithBrotli(uaRawResponse)) {
                await context.report(resource, element, generateCompressionMessage('Brotli', false, `over HTTPS regardless of the user agent`));
            }
        };

        const checkGzipZopfli = async (resource: string, element: IAsyncHTMLElement, shouldCheckIfCompressedWith: CompressionCheckOptions) => {
            const { contentEncodingHeaderValue, rawContent, rawResponse, response } = await getNetworkData(resource, { 'Accept-Encoding': 'gzip' });

            const compressedWithGzip = isCompressedWithGzip(rawResponse);
            const notCompressedWithZopfli = isNotCompressedWithZopfli(rawResponse);
            const itShouldNotBeCompressed = contentEncodingHeaderValue === 'gzip' &&
                rawContent.byteLength <= rawResponse.byteLength;

            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

            // Check compressed vs. uncompressed sizes.

            if (compressedWithGzip && itShouldNotBeCompressed) {
                generateSizeMessage(resource, element, notCompressedWithZopfli ? 'gzip' : 'Zopfli', rawResponse.byteLength - rawContent.byteLength);

                return;
            }

            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

            // Check if compressed.

            if (!compressedWithGzip && shouldCheckIfCompressedWith.gzip) {
                await context.report(resource, element, generateCompressionMessage('gzip'));

                return;
            }

            if (notCompressedWithZopfli && shouldCheckIfCompressedWith.zopfli) {
                await context.report(resource, element, generateCompressionMessage('Zopfli'));
            }

            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

            // Check related headers.

            if (shouldCheckIfCompressedWith.gzip ||
                shouldCheckIfCompressedWith.zopfli) {
                await checkVaryHeader(resource, element, response.headers);

                if (contentEncodingHeaderValue !== 'gzip') {
                    await context.report(resource, element, generateContentEncodingMessage('gzip'));
                }
            }

            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

            // Check for user agent sniffing.

            const { rawResponse: uaRawResponse } = await getNetworkData(resource, {
                'Accept-Encoding': 'gzip',
                'User-Agent': uaString
            });

            if (!isCompressedWithGzip(uaRawResponse) &&
                shouldCheckIfCompressedWith.gzip) {
                await context.report(resource, element, generateCompressionMessage('gzip', false, `regardless of the user agent`));

                return;
            }

            if (isNotCompressedWithZopfli(uaRawResponse) &&
                !notCompressedWithZopfli &&
                shouldCheckIfCompressedWith.zopfli) {
                await context.report(resource, element, generateCompressionMessage('Zopfli', false, `regardless of the user agent`));
            }

        };

        const responseIsCompressed = (rawResponse: Buffer, contentEncodingHeaderValue: string): boolean => {
            return isCompressedWithGzip(rawResponse) ||
                isCompressedWithBrotli(rawResponse) ||

                /*
                 * Other compression methods may be used, but there is
                 * no way to check for all possible cases. So, if this
                 * point is reached, just consider 'content-encoding'
                 * header as a possible indication of the response being
                 * compressed.
                 */

                (contentEncodingHeaderValue &&

                    /*
                     * Although `identity` should not be sent as
                     * a value for `content-encoding`, if sent, for
                     * the * scope of this function, just ignore it
                     * and consider no encoding was specified.
                     *
                     *  From (now kinda obsolete)
                     *  https://tools.ietf.org/html/rfc2616#page-24:
                     *
                     *  " identity
                     *
                     *    The default (identity) encoding; the use of no
                     *    transformation whatsoever. This content-coding
                     *    is used only in the Accept-Encoding header, and
                     *    SHOULD NOT be used in the Content-Encoding header. "
                     *
                     *  See also: http://httpwg.org/specs/rfc7231.html#content.coding.registration
                     */

                    (contentEncodingHeaderValue !== 'identity'));
        };

        const checkForDisallowedCompressionMethods = async (resource: string, element: IAsyncHTMLElement, response: IResponse) => {

            // See: https://www.iana.org/assignments/http-parameters/http-parameters.xml.

            const contentEncodingHeaderValue = getHeaderValueNormalized(response.headers, 'content-encoding');

            if (!contentEncodingHeaderValue) {
                return;
            }

            const encodings = contentEncodingHeaderValue.split(',');

            for (const encoding of encodings) {
                if (!['gzip', 'br'].includes(encoding)) {

                    /*
                     * `x-gzip` is deprecated but usually user agents
                     * alias it to `gzip`, so if the content is actual
                     * `gzip`, don't trigger an error here as the gzip
                     * related check will show an error for the response
                     * not being served with `content-encoding: gzip`.
                     */

                    if (encoding === 'x-gzip' && isCompressedWithGzip(await response.body.rawResponse())) {
                        return;
                    }

                    // For anything else just flag it as disallowed.
                    await context.report(resource, element, generateDisallowedCompressionMessage(encoding));
                }
            }

            /*
             * Special cases:
             *
             *  * SDCH (Shared Dictionary Compression over HTTP)
             *    https://lists.w3.org/Archives/Public/ietf-http-wg/2008JulSep/att-0441/Shared_Dictionary_Compression_over_HTTP.pdf
             *    Theoretically this should only happen if the user
             *    agent advertises support for SDCH, but yet again,
             *    server might be misconfigured.
             *
             *    For SDCH, the first response will not contain anything
             *    special regarding the `content-encoding` header, however,
             *    it will contain the `get-dictionary` header.
             */

            if (normalizeString(response.headers['get-dictionary'])) {
                await context.report(resource, element, generateDisallowedCompressionMessage('sdch'));
            }
        };

        const checkUncompressed = async (resource: string, element: IAsyncHTMLElement) => {

            /*
             * From: http://httpwg.org/specs/rfc7231.html#header.accept-encoding
             *
             *   " An "identity" token is used as a synonym for
             *     "no encoding" in order to communicate when no
             *     encoding is preferred.
             *
             *     ...
             *
             *     If no Accept-Encoding field is in the request,
             *     any content-coding is considered acceptable by
             *     the user agent. "
             */

            const { contentEncodingHeaderValue, rawResponse } = await getNetworkData(resource, { 'Accept-Encoding': 'identity' });

            if (responseIsCompressed(rawResponse, contentEncodingHeaderValue)) {
                await context.report(resource, element, generateCompressionMessage('', true, `for requests made with 'Accept-Encoding: identity'`));
            }

            if (contentEncodingHeaderValue) {
                await context.report(resource, element, generateContentEncodingMessage('', true, `for requests made with 'Accept-Encoding: identity'`));
            }
        };

        const isCompressibleAccordingToMediaType = (mediaType: string): boolean => {
            const COMMON_MEDIA_TYPES_THAT_SHOULD_BE_COMPRESSED = [
                'image/x-icon',
                'image/bmp'
            ];

            const COMMON_MEDIA_TYPES_THAT_SHOULD_NOT_BE_COMPRESSED = [
                'image/jpeg',
                'image/png',
                'image/gif',
                'font/woff2',
                'font/woff',
                'font/otf',
                'font/ttf'
            ];

            if (!mediaType) {
                return false;
            }

            /*
             * The reason for doing the following is because
             * `mime-db` is quite big, so querying it for
             * eveything is expensive.
             */

            /*
             * Check if the media type is one of the common
             * ones for which it is known the response should
             * be compressed.
             */

            if (isTextMediaType(mediaType) ||
                COMMON_MEDIA_TYPES_THAT_SHOULD_BE_COMPRESSED.includes(mediaType)) {
                return true;
            }

            /*
             * Check if the media type is one of the common
             * ones for which it is known the response should
             * not be compressed.
             */

            if (COMMON_MEDIA_TYPES_THAT_SHOULD_NOT_BE_COMPRESSED.includes(mediaType)) {
                return false;
            }

            /*
             * If the media type is not included in any of the
             * above, check `mime-db`.
             */

            const typeInfo = mimeDB[mediaType];

            return typeInfo && typeInfo.compressible;

        };

        const isSpecialCase = async (resource: string, element: IAsyncHTMLElement, response: IResponse): Promise<boolean> => {

            /*
             * Check for special cases:
             *
             *  * Files that are by default compressed with gzip.
             *
             *    SVGZ files are by default compressed with gzip, so
             *    by not sending them with the `Content-Encoding: gzip`
             *    header, browsers will not be able to display them
             *    correctly.
             */

            if ((response.mediaType === 'image/svg+xml' || getFileExtension(resource) === 'svgz') &&
                isCompressedWithGzip(await response.body.rawResponse())) {

                if (getHeaderValueNormalized(response.headers, 'content-encoding') !== 'gzip') {
                    await context.report(resource, element, generateContentEncodingMessage('gzip'));
                }

                return true;
            }

            return false;
        };

        const validate = (shouldCheckIfCompressedWith: CompressionCheckOptions) => {
            return async (fetchEnd: IFetchEnd) => {
                const { element, resource, response }: { element: IAsyncHTMLElement, resource: string, response: IResponse } = fetchEnd;

                /*
                 * We shouldn't validate error responses, and 204 (response with no body).
                 * Also some sites return body with 204 status code and that breaks `request`:
                 * https://github.com/request/request/issues/2669
                 */
                if (response.statusCode !== 200) {
                    return;
                }

                // It doesn't make sense for things that are not served over http(s)
                if (!isRegularProtocol(resource)) {
                    return;
                }

                // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

                /*
                 * Check if this is a special case, and if it is, do the
                 * specific checks, but ignore all the checks that follow.
                 */

                if (await isSpecialCase(resource, element, response)) {
                    return;
                }

                // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

                // If the resource should not be compressed:
                if (!isCompressibleAccordingToMediaType(response.mediaType)) {

                    const rawResponse = await response.body.rawResponse();
                    const contentEncodingHeaderValue = getHeaderValueNormalized(response.headers, 'content-encoding');

                    // * Check if the resource is actually compressed.
                    if (responseIsCompressed(rawResponse, contentEncodingHeaderValue)) {
                        await context.report(resource, element, generateCompressionMessage('', true));
                    }

                    // * Check if resource is sent with the `Content-Encoding` header.
                    if (contentEncodingHeaderValue) {
                        await context.report(resource, element, `Should not be served with the 'content-encoding' header.`);
                    }

                    return;
                }

                // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

                /*
                 * If the resource should be compressed:
                 *
                 *  * Check if the resource is sent compressed with an
                 *    deprecated or not recommended compression method.
                 */

                await checkForDisallowedCompressionMethods(resource, element, response);

                // - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

                /*
                 *  * Check if it's actually compressed and served in
                 *    the correct/required compressed format.
                 *
                 *    Note: Checking if servers respect the qvalue
                 *          is beyond of the scope for the time being,
                 *          so the followings won't check that.
                 */

                await checkUncompressed(resource, element);

                if (shouldCheckIfCompressedWith.gzip ||
                    shouldCheckIfCompressedWith.zopfli) {
                    await checkGzipZopfli(resource, element, shouldCheckIfCompressedWith);
                }

                if (shouldCheckIfCompressedWith.brotli) {
                    await checkBrotli(resource, element);
                }
            };
        };

        return {
            'fetch::end': validate(resourceOptions),
            'manifestfetch::end': validate(resourceOptions),
            'targetfetch::end': validate(targetOptions)
        };
    },
    meta: {
        docs: {
            category: Category.performance,
            description: 'Require resources to be served compressed'
        },
        recommended: true,
        schema: [{
            additionalProperties: false,
            definitions: {
                options: {
                    additionalProperties: false,
                    minProperties: 1,
                    properties: {
                        brotli: { type: 'boolean' },
                        gzip: { type: 'boolean' },
                        zopfli: { type: 'boolean' }
                    }
                }
            },
            properties: {
                resource: { $ref: '#/definitions/options' },
                target: { $ref: '#/definitions/options' }
            },
            type: 'object'
        }],
        worksWithLocalFiles: false
    }
};

export default rule;
