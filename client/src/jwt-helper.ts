import { createHmac } from 'crypto';

// JWT Claims for Genesys AudioHook
export interface JwtClaims {
    iss: string;        // issuer
    aud: string;        // audience
    exp: number;        // expiration time
    iat?: number;       // issued at
    orgId?: string;     // organization ID
    conversationId?: string;
    participantId?: string;
    sub?: string;       // subject
    [key: string]: unknown;
}

// Create a JWT token for Genesys AudioHook authentication
export function createJwtToken(
    apiKey: string,
    clientSecret: string,
    organizationId: string,
    sessionId: string,
    correlationId: string,
    options?: {
        conversationId?: string;
        participantId?: string;
        expiresIn?: number; // seconds
    }
): string {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = options?.expiresIn || 3600; // 1 hour default
    
    const header = {
        alg: 'HS256',
        typ: 'JWT'
    };
    
    const payload: JwtClaims = {
        iss: 'genesys',
        aud: 'audiohook',
        exp: now + expiresIn,
        iat: now,
        orgId: organizationId,
        conversationId: options?.conversationId,
        participantId: options?.participantId,
        sub: apiKey
    };
    
    // Base64url encode without padding
    const base64UrlEncode = (str: string): string => {
        return Buffer.from(str)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    };
    
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    
    // Create signature
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = createHmac('sha256', clientSecret)
        .update(signingInput)
        .digest('base64url');
    
    return `${signingInput}.${signature}`;
}

// Add JWT token to request headers
export function addJwtHeaders(
    existingHeaders: Record<string, string>,
    jwtToken: string
): Record<string, string> {
    return {
        ...existingHeaders,
        'Authorization': `Bearer ${jwtToken}`
    };
}
