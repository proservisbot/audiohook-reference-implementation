import { FastifyRequest } from 'fastify';
import {
    Logger,
    ServerSession as Session,
} from '../audiohook';
import { queryCanonicalizedHeaderField } from '../audiohook/httpsignature';

// JWT Claims expected from Genesys AudioHook
export interface AudioHookJwtClaims {
    iss: string;
    aud: string;
    exp: number;
    orgId?: string;
    conversationId?: string;
    participantId?: string;
    iat?: number;
    sub?: string;
    [key: string]: unknown;
}

// Result of JWT verification
export type JwtVerifyResult = 
    | { code: 'VERIFIED'; payload: AudioHookJwtClaims }
    | { code: 'MISSING_TOKEN'; reason: string }
    | { code: 'INVALID_TOKEN'; reason: string }
    | { code: 'EXPIRED'; reason: string }
    | { code: 'INVALID_ISSUER'; reason: string }
    | { code: 'INVALID_AUDIENCE'; reason: string }
    | { code: 'ORG_MISMATCH'; reason: string }
    | { code: 'VERIFICATION_ERROR'; reason: string };

// Configuration for JWT authentication
export type JwtAuthConfig = {
    enabled: boolean;
    // Map of orgId to client secret (for multi-tenant support)
    // Can also use a single secret with '*' as wildcard orgId
    orgSecrets: Map<string, string>;
    // Expected issuer (default: 'genesys')
    expectedIssuer: string;
    // Expected audience (default: 'audiohook')
    expectedAudience: string;
    // Clock skew tolerance in seconds (default: 60)
    clockToleranceSeconds: number;
};

// Parse JWT without verification to extract header and payload
function parseJwt(token: string): { header: unknown; payload: unknown } | null {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) {
            return null;
        }
        
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        
        return { header, payload };
    } catch {
        return null;
    }
}

// Verify HMAC-SHA256 signature using Node.js crypto
import { createHmac } from 'crypto';

async function verifyHmacSha256(token: string, secret: string): Promise<boolean> {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) {
            return false;
        }
        
        const signingInput = `${parts[0]}.${parts[1]}`;
        const signature = parts[2];
        
        const hmac = createHmac('sha256', secret);
        hmac.update(signingInput);
        const computedSignature = hmac.digest('base64url');
        
        // Constant-time comparison to prevent timing attacks
        if (computedSignature.length !== signature.length) {
            return false;
        }
        
        let result = 0;
        for (let i = 0; i < computedSignature.length; i++) {
            result |= computedSignature.charCodeAt(i) ^ signature.charCodeAt(i);
        }
        
        return result === 0;
    } catch {
        return false;
    }
}

// Extract JWT token from request (Authorization header or query parameter)
function extractJwtToken(request: FastifyRequest): string | null {
    // Try Authorization header first: "Authorization: Bearer <token>"
    const authHeader = request.headers.authorization;
    if (authHeader) {
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (match) {
            return match[1];
        }
    }
    
    // Try query parameter: ?token=<jwt>
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const tokenParam = url.searchParams.get('token');
    if (tokenParam) {
        return tokenParam;
    }
    
    return null;
}

// Get configuration from environment variables
export function getJwtAuthConfig(): JwtAuthConfig {
    const enabled = process.env['AUDIOHOOK_JWT_AUTH_ENABLED'] === 'true';
    
    const orgSecrets = new Map<string, string>();
    
    // Support single secret for all orgs (wildcard)
    const singleSecret = process.env['AUDIOHOOK_JWT_CLIENT_SECRET'];
    if (singleSecret) {
        orgSecrets.set('*', singleSecret);
    }
    
    // Support multi-tenant: AUDIOHOOK_JWT_SECRET_<ORGID>=<secret>
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('AUDIOHOOK_JWT_SECRET_')) {
            const orgId = key.replace('AUDIOHOOK_JWT_SECRET_', '');
            if (orgId && value) {
                orgSecrets.set(orgId, value);
            }
        }
    }
    
    // Support JSON format: AUDIOHOOK_JWT_SECRETS={"org1": "secret1", "org2": "secret2"}
    const secretsJson = process.env['AUDIOHOOK_JWT_SECRETS'];
    if (secretsJson) {
        try {
            const parsed = JSON.parse(secretsJson);
            for (const [orgId, secret] of Object.entries(parsed)) {
                if (typeof secret === 'string') {
                    orgSecrets.set(orgId, secret);
                }
            }
        } catch (e) {
            console.error('Failed to parse AUDIOHOOK_JWT_SECRETS:', e);
        }
    }
    
    return {
        enabled,
        orgSecrets,
        expectedIssuer: process.env['AUDIOHOOK_JWT_ISSUER'] || 'genesys',
        expectedAudience: process.env['AUDIOHOOK_JWT_AUDIENCE'] || 'audiohook',
        clockToleranceSeconds: parseInt(process.env['AUDIOHOOK_JWT_CLOCK_SKEW'] || '60', 10),
    };
}

// Get client secret for org (supports wildcard)
function getSecretForOrg(config: JwtAuthConfig, orgId: string): string | undefined {
    // Try exact match first
    if (config.orgSecrets.has(orgId)) {
        return config.orgSecrets.get(orgId);
    }
    // Fall back to wildcard
    return config.orgSecrets.get('*');
}

// Verify JWT token
export async function verifyJwtToken(
    token: string,
    config: JwtAuthConfig,
    requestOrgId?: string,
    logger?: Logger
): Promise<JwtVerifyResult> {
    try {
        // Parse JWT to extract payload without verification
        const parsed = parseJwt(token);
        if (!parsed) {
            return { code: 'INVALID_TOKEN', reason: 'Malformed JWT token' };
        }
        
        const payload = parsed.payload as AudioHookJwtClaims;
        
        // Validate required claims
        if (!payload.iss) {
            return { code: 'INVALID_TOKEN', reason: 'Missing "iss" claim' };
        }
        if (!payload.aud) {
            return { code: 'INVALID_TOKEN', reason: 'Missing "aud" claim' };
        }
        if (!payload.exp) {
            return { code: 'INVALID_TOKEN', reason: 'Missing "exp" claim' };
        }
        
        // Validate issuer
        if (payload.iss !== config.expectedIssuer) {
            logger?.warn(`Invalid issuer: expected "${config.expectedIssuer}", got "${payload.iss}"`);
            return { 
                code: 'INVALID_ISSUER', 
                reason: `Invalid issuer: expected "${config.expectedIssuer}", got "${payload.iss}"` 
            };
        }
        
        // Validate audience
        if (payload.aud !== config.expectedAudience) {
            logger?.warn(`Invalid audience: expected "${config.expectedAudience}", got "${payload.aud}"`);
            return { 
                code: 'INVALID_AUDIENCE', 
                reason: `Invalid audience: expected "${config.expectedAudience}", got "${payload.aud}"` 
            };
        }
        
        // Validate expiration
        const now = Math.floor(Date.now() / 1000);
        const expWithTolerance = payload.exp + config.clockToleranceSeconds;
        if (now > expWithTolerance) {
            logger?.warn(`Token expired at ${payload.exp}, current time is ${now}`);
            return { 
                code: 'EXPIRED', 
                reason: `Token expired at ${new Date(payload.exp * 1000).toISOString()}` 
            };
        }
        
        // Validate issued-at if present
        if (payload.iat && payload.iat > now + config.clockToleranceSeconds) {
            logger?.warn(`Token issued in future: ${payload.iat}`);
            return { code: 'INVALID_TOKEN', reason: 'Token issued in the future' };
        }
        
        // Get orgId from token or from request header
        const tokenOrgId = payload.orgId;
        const effectiveOrgId = tokenOrgId || requestOrgId;
        
        if (!effectiveOrgId) {
            logger?.warn('No orgId in token or request headers');
            return { code: 'INVALID_TOKEN', reason: 'Missing orgId in token and request headers' };
        }
        
        // Validate orgId matches request if both present
        if (tokenOrgId && requestOrgId && tokenOrgId !== requestOrgId) {
            logger?.warn(`OrgId mismatch: token has "${tokenOrgId}", request has "${requestOrgId}"`);
            return { 
                code: 'ORG_MISMATCH', 
                reason: `OrgId mismatch between token and request` 
            };
        }
        
        // Get client secret for this org
        const clientSecret = getSecretForOrg(config, effectiveOrgId);
        if (!clientSecret) {
            logger?.warn(`No client secret configured for org "${effectiveOrgId}"`);
            return { 
                code: 'VERIFICATION_ERROR', 
                reason: `No client secret configured for organization` 
            };
        }
        
        // Verify signature
        const isValid = await verifyHmacSha256(token, clientSecret);
        if (!isValid) {
            logger?.warn('JWT signature verification failed');
            return { code: 'VERIFICATION_ERROR', reason: 'Invalid JWT signature' };
        }
        
        logger?.info(`JWT verified successfully for org "${effectiveOrgId}"`);
        return { code: 'VERIFIED', payload };
        
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error';
        logger?.error(`JWT verification error: ${reason}`);
        return { code: 'VERIFICATION_ERROR', reason: `Verification failed: ${reason}` };
    }
}

// Main function to verify JWT from request
export type VerifyJwtParams = {
    request: FastifyRequest;
    config?: JwtAuthConfig;
    logger?: Logger;
};

export async function verifyRequestJwt(params: VerifyJwtParams): Promise<JwtVerifyResult> {
    const { request, logger } = params;
    const config = params.config ?? getJwtAuthConfig();
    
    if (!config.enabled) {
        return { code: 'VERIFICATION_ERROR', reason: 'JWT authentication not enabled' };
    }
    
    if (config.orgSecrets.size === 0) {
        return { code: 'VERIFICATION_ERROR', reason: 'No client secrets configured' };
    }
    
    const token = extractJwtToken(request);
    if (!token) {
        return { code: 'MISSING_TOKEN', reason: 'No JWT token found in Authorization header or query parameters' };
    }
    
    // Get orgId from request headers for validation
    const requestOrgId = queryCanonicalizedHeaderField(request.headers, 'audiohook-organization-id') || undefined;
    
    return verifyJwtToken(token, config, requestOrgId, logger);
}

// Integrate JWT auth into session (similar to existing authenticator pattern)
export type FailureSignalingMode = 'immediate' | 'open';

export type InitiateJwtAuthenticationParams = {
    session: Session;
    request: FastifyRequest;
    config?: JwtAuthConfig;
    failureSignalingMode?: FailureSignalingMode;
};

export const initiateJwtAuthentication = (params: InitiateJwtAuthenticationParams): void => {
    const { session, request, failureSignalingMode } = params;
    const config = params.config ?? getJwtAuthConfig();
    
    if (!config.enabled) {
        session.logger.warn('JWT authentication called but not enabled');
        return;
    }
    
    const signalingMode = failureSignalingMode ?? 'immediate';
    
    // Perform JWT verification
    const resultPromise = verifyRequestJwt({
        request,
        config,
        logger: session.logger,
    }).then(result => {
        session.logger.info(`JWT verification resolved: ${result.code}`);
        
        if (result.code === 'VERIFIED') {
            // Log successful authentication details
            const payload = result.payload;
            session.logger.info(`JWT authentication successful - orgId: ${payload.orgId}, conversationId: ${payload.conversationId}, participantId: ${payload.participantId}, exp: ${new Date(payload.exp * 1000).toISOString()}`);
            return result;
        } else if (signalingMode === 'immediate') {
            // Signal failure immediately
            session.disconnect('unauthorized', result.reason ? `${result.code}: ${result.reason}` : result.code);
        }
        return result;
    });
    
    // Add authenticator to session
    session.addAuthenticator(async (session) => {
        const result = await resultPromise;
        session.logger.debug(`JWT Authenticator - Verification result: ${result.code}`);
        
        if (result.code !== 'VERIFIED') {
            return result.reason ? `${result.code}: ${result.reason}` : result.code;
        }
        return true;
    });
};
