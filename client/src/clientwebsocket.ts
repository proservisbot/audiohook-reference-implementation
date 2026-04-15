import { URL } from 'url';
import { WebSocket } from 'ws';
import { ClientWebSocketFactory, httpsignature } from '../../app/audiohook';
import { createJwtToken } from './jwt-helper';

export const createClientWebSocket: ClientWebSocketFactory = ({
    uri, 
    organizationId, 
    sessionId, 
    correlationId, 
    authInfo,
    logger,
}) => {
    const url = new URL(uri);
    const requestHeaders: Record<string, string> = {
        'Audiohook-Organization-Id': organizationId,
        'Audiohook-Session-Id': sessionId,
        'Audiohook-Correlation-Id': correlationId,
        'X-API-KEY': authInfo.apiKey,
    };

    // Check if we should use JWT authentication
    if (authInfo.clientSecret && shouldUseJwtAuth()) {
        logger.info('Using JWT authentication');
        
        // Create JWT token
        const clientSecretStr = Buffer.from(authInfo.clientSecret).toString('base64');
        const jwtToken = createJwtToken(
            authInfo.apiKey,
            clientSecretStr,
            organizationId,
            sessionId,
            correlationId
        );
        
        // Add JWT Authorization header
        requestHeaders['Authorization'] = `Bearer ${jwtToken}`;
        
        // Remove signature-related headers for JWT auth
        delete requestHeaders['signature'];
        delete requestHeaders['signature-input'];
    } else {
        logger.info('Using HTTP signature authentication');
        
        // Use existing signature-based authentication
        const signatureHeaders = authInfo.clientSecret ? (
            new httpsignature.SignatureBuilder()
                .addComponent('@request-target', url.pathname + url.search)
                .addComponent('@authority', url.host)   // Note: host is normalized (excludes default port even if specified in source)
                .addComponent('audiohook-organization-id', organizationId)
                .addComponent('audiohook-session-id', sessionId)
                .addComponent('audiohook-correlation-id', correlationId)
                .addComponent('x-api-key', authInfo.apiKey)
                .createSignature({
                    keyid: authInfo.apiKey,
                    key: authInfo.clientSecret
                })
        ) : null;
        
        Object.assign(requestHeaders, signatureHeaders);
    }
    
    logger.info(`Request headers: ${JSON.stringify(requestHeaders, null, 1)}`);

    return new WebSocket(
        uri,
        {
            followRedirects: false,
            headers: requestHeaders
        }
    );
};

// Determine if JWT authentication should be used
function shouldUseJwtAuth(): boolean {
    // Check environment variable or use JWT by default for new authentication
    const authMode = process.env['AUDIOHOOK_AUTH_MODE'];
    return authMode !== 'legacy'; // Use JWT unless explicitly set to legacy
}

