#!/usr/bin/env node
/**
 * Automated Dual-Stream SIPREC Call Simulator
 * 
 * This script simulates a person-to-person call with two audio streams:
 * - Customer (caller/inbound leg)
 * - Agent (callee/outbound leg)
 * 
 * Both legs share the same conversationId but have different participantIds.
 */

import { Command } from 'commander';
import { pino } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import {
    ClientSession,
    createClientSession,
    StreamDuration,
    MediaSource,
} from '../../app/audiohook';
import { createClientWebSocket } from './clientwebsocket';
import { createWavMediaSource } from './mediasource-wav';

const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: {
            translateTime: 'SYS:HH:MM:ss.l',
            colorize: true,
            ignore: 'pid,hostname'
        }
    }
});

interface ConversationJson {
  conversation_id: string;
  topic: string;
  participants: {
    agent: { name: string; role?: string };
    customer: { name: string };
  };
  transcript: Array<{
    timestamp: string;
    speaker: 'agent' | 'customer';
    intent: string;
    text: string;
  }>;
}

interface CmdOptions {
  conversation: string;
  server: string;
  agentWav?: string;
  customerWav?: string;
  apiKey?: string;
  clientSecret?: string;
  organizationId?: string;
  verbose: boolean;
  delay: string;
}

interface LegSession {
  name: string;
  role: 'customer' | 'agent';
  participant: { id: string; ani: string; aniName: string; dnis: string };
  wavPath: string;
  session?: ClientSession;
  completed: boolean;
}

new Command()
  .name('automated-dual-call')
  .description('Automated Dual-Stream SIPREC Call Simulator')
  .option('-c, --conversation <file>', 'Path to conversation JSON file (required)', '')
  .option('-s, --server <url>', 'AudioHook server URL', 'ws://localhost:8080/audiohook/websocket')
  .option('--agent-wav <file>', 'Path to agent audio WAV file (optional, auto-detected)')
  .option('--customer-wav <file>', 'Path to customer audio WAV file (optional, auto-detected)')
  .option('--api-key <key>', 'API key for authentication', 'test-api-key')
  .option('--client-secret <secret>', 'Client secret for authentication')
  .option('--organization-id <id>', 'Organization ID', '00000000-0000-0000-0000-000000000001')
  .option('--delay <ms>', 'Delay between starting legs in ms', '500')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options: CmdOptions) => {
    if (!options.conversation) {
      logger.error('Error: --conversation is required');
      process.exit(1);
    }

    // Load conversation JSON
    let conversationData: ConversationJson;
    try {
      const conversationPath = path.resolve(options.conversation);
      const conversationContent = fs.readFileSync(conversationPath, 'utf-8');
      conversationData = JSON.parse(conversationContent) as ConversationJson;
      logger.info(`[Automated Call] Loaded conversation: ${conversationData.conversation_id}`);
      logger.info(`[Automated Call] Topic: ${conversationData.topic}`);
      logger.info(`[Automated Call] Participants: ${conversationData.participants.customer.name} (customer) <> ${conversationData.participants.agent.name} (agent)`);
    } catch (err) {
      logger.error(`[Automated Call] Failed to load conversation file: ${err}`);
      process.exit(1);
    }

    // Auto-detect audio files if not provided
    const baseName = conversationData.conversation_id;
    const conversationDir = path.dirname(path.resolve(options.conversation));

    const customerWavPath = options.customerWav || path.join(conversationDir, '../audio', `${baseName}_customer.wav`);
    const agentWavPath = options.agentWav || path.join(conversationDir, '../audio', `${baseName}_agent.wav`);

    logger.info(`[Automated Call] Customer audio: ${customerWavPath}`);
    logger.info(`[Automated Call] Agent audio: ${agentWavPath}`);

    // Verify audio files exist
    if (!fs.existsSync(customerWavPath)) {
      logger.error(`[Automated Call] Customer audio file not found: ${customerWavPath}`);
      process.exit(1);
    }
    if (!fs.existsSync(agentWavPath)) {
      logger.error(`[Automated Call] Agent audio file not found: ${agentWavPath}`);
      process.exit(1);
    }

    // Shared conversation ID for both legs
    const conversationId = conversationData.conversation_id;

    // Create participant info for each leg
    const customerParticipant = {
      id: uuidv4(),
      ani: '+15551234567',
      aniName: conversationData.participants.customer.name,
      dnis: '+18001234567',
    };

    const agentParticipant = {
      id: uuidv4(),
      ani: '+18001234567',
      aniName: conversationData.participants.agent.name,
      dnis: '+15551234567',
    };

    const legs: LegSession[] = [
      {
        name: conversationData.participants.customer.name,
        role: 'customer',
        participant: customerParticipant,
        wavPath: customerWavPath,
        completed: false,
      },
      {
        name: conversationData.participants.agent.name,
        role: 'agent',
        participant: agentParticipant,
        wavPath: agentWavPath,
        completed: false,
      },
    ];

    async function startLeg(leg: LegSession, uri: string, organizationId: string, apiKey: string, clientSecret: Uint8Array | undefined, verbose: boolean): Promise<void> {
      return new Promise((resolve, reject) => {
        logger.info(`[${leg.role.toUpperCase()}] Starting leg for ${leg.name}...`);

        // Create media source
        createWavMediaSource(leg.wavPath)
          .then((mediaSource: MediaSource) => {
            // Create session using the same pattern as index.ts
            const session = createClientSession({
              uri,
              mediaSource,
              organizationId,
              sessionId: uuidv4(),
              conversationId,
              participant: leg.participant,
              createWebSocket: createClientWebSocket,
              logger: logger.child({ leg: leg.role }),
              authInfo: {
                apiKey: apiKey,
                clientSecret: clientSecret ?? null
              },
            });

            leg.session = session;

            // Log events from session
            session.on('event', (parameters) => {
              if (verbose) {
                logger.info(`[${leg.role.toUpperCase()}] Event: ${JSON.stringify(parameters, null, 1)}`);
              }
            });

            session.on('rttInfo', (rtt: number) => {
              if (verbose) {
                logger.info(`[${leg.role.toUpperCase()}] RTT: ${(rtt * 1000).toFixed(2)}ms`);
              }
            });

            session.once('disconnected', () => {
              logger.info(`[${leg.role.toUpperCase()}] Session disconnected`);
              leg.completed = true;
              resolve();
            });

            logger.info(`[${leg.role.toUpperCase()}] Session created and connecting to ${uri}...`);
          })
          .catch((err: Error) => {
            logger.error(`[${leg.role.toUpperCase()}] Failed to create media source: ${err.message}`);
            reject(err);
          });
      });
    }

    async function runAutomatedCall(): Promise<void> {
      logger.info(`\n[Automated Call] ==========================================`);
      logger.info(`[Automated Call] Starting automated dual-stream call`);
      logger.info(`[Automated Call] Conversation ID: ${conversationId}`);
      logger.info(`[Automated Call] Server: ${options.server}`);
      logger.info(`[Automated Call] ==========================================\n`);

      const clientSecret = options.clientSecret ? Buffer.from(options.clientSecret, 'base64') : undefined;
      const delay = parseInt(options.delay, 10) || 500;

      try {
        // Start customer leg first (will be 'caller' in conversation manager)
        const customerPromise = startLeg(legs[0], options.server, options.organizationId!, options.apiKey!, clientSecret, options.verbose);
        
        // Small delay before starting agent leg
        if (delay > 0) {
          logger.info(`[Automated Call] Waiting ${delay}ms before starting agent leg...`);
          await new Promise(r => setTimeout(r, delay));
        }
        
        // Start agent leg (will be 'agent' in conversation manager)
        const agentPromise = startLeg(legs[1], options.server, options.organizationId!, options.apiKey!, clientSecret, options.verbose);

        // Wait for both legs to complete
        await Promise.all([customerPromise, agentPromise]);

        logger.info(`\n[Automated Call] ==========================================`);
        logger.info(`[Automated Call] Both legs completed successfully`);
        logger.info(`[Automated Call] Conversation ID: ${conversationId}`);
        logger.info(`[Automated Call] ==========================================`);
        
        process.exit(0);
      } catch (err) {
        logger.error(`\n[Automated Call] Error: ${err}`);
        
        // Clean up any active sessions
        for (const leg of legs) {
          if (leg.session) {
            logger.info(`[Automated Call] Cleaning up ${leg.role} session...`);
            try {
              await leg.session.close();
            } catch {
              // Ignore cleanup errors
            }
          }
        }
        
        process.exit(1);
      }
    }

    // Handle process termination
    process.on('SIGINT', async () => {
      logger.info('\n[Automated Call] Interrupted, cleaning up...');
      for (const leg of legs) {
        if (leg.session) {
          try {
            await leg.session.close();
          } catch {
            // Ignore
          }
        }
      }
      process.exit(0);
    });

    // Run
    await runAutomatedCall();
  })
  .parseAsync(process.argv);
