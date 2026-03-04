import { EventEmitter } from 'events';
import {
    MediaChannels,
    MediaParameter,
    MediaParameters,
    MediaRate,
    MediaSource,
    MediaSourceState,
    OnMediaSourceAudioHandler,
    OnMediaSourceClosedHandler,
    OnMediaSourceDiscardedHandler,
    OnMediaSourceEndHandler,
    OnMediaSourceErrorHandler,
    OnMediaSourcePausedHandler,
    OnMediaSourceResumedHandler,
    StreamDuration,
} from '../../app/audiohook';
import { ulawFromL16 } from '../../app/audiohook/src/audio/ulaw';

// Dynamic import for record module to avoid errors if not installed
let recordModule: {
    record(options?: {
        sampleRate?: number;
        channels?: number;
        audioType?: string;
        encoding?: string;
        bitDepth?: number;
    }): {
        stop(): void;
        pause(): void;
        resume(): void;
        stream(): NodeJS.ReadableStream;
    };
} | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    recordModule = require('node-record-lpcm16');
} catch {
    // Module not installed
}

interface Recorder {
    stop(): void;
    pause(): void;
    resume(): void;
    stream(): NodeJS.ReadableStream;
}

class MediaSourceMicrophone extends EventEmitter implements MediaSource {
    readonly offeredMedia: MediaParameters;
    selectedMedia: MediaParameter | null = null;
    state: MediaSourceState = 'PREPARING';
    private sampleRate: MediaRate = 8000;
    private samplePos = 0;
    private pauseStartPos = 0;
    private microphoneRecorder: Recorder | null = null;
    private readonly sampleEndPos: number;
    private frameDurationMs = 20; // 20ms frames
    private audioTimer: NodeJS.Timeout | null = null;
    private frameCount = 0;
    private logInterval = 50; // Log every 50 frames (1 second)

    constructor(maxDuration?: StreamDuration) {
        super();
        const channels: MediaChannels[] = [['external'], ['internal']];
        this.offeredMedia = channels.map(channels => ({ 
            type: 'audio', 
            format: 'PCMU', // u-law format for AudioHook compatibility
            channels, 
            rate: this.sampleRate 
        }));
        this.sampleEndPos = Math.trunc((maxDuration?.seconds ?? 7*24*3600) * this.sampleRate);
    }

    startStreaming(selectedMedia: MediaParameter | null, discardTo?: StreamDuration, startPaused?: boolean): void {
        console.log('[MediaSource] startStreaming called, state:', this.state);
        if(this.state !== 'PREPARING') {
            throw new Error(`Cannot start stream in state '${this.state}'`);
        }

        if (!recordModule) {
            console.error('[MediaSource] ERROR: node-record-lpcm16 not installed');
            this.state = 'CLOSED';
            this.emit('error', new Error('node-record-lpcm16 not installed. Run: npm install node-record-lpcm16'));
            return;
        }
        console.log('[MediaSource] recordModule available');

        this.selectedMedia = selectedMedia;

        if(discardTo) {
            const samplesPerFrame = Math.trunc(this.frameDurationMs*this.sampleRate/1000);
            const newSamplePosRaw = Math.round(discardTo.seconds*this.sampleRate);
            let newSamplePos = Math.floor(newSamplePosRaw/samplesPerFrame)*samplesPerFrame;
            newSamplePos = Math.min(this.sampleEndPos, newSamplePos);
            if(this.samplePos < newSamplePos) {
                const start = StreamDuration.fromSamples(this.samplePos, this.sampleRate);
                const discarded = StreamDuration.fromSamples(newSamplePos - this.samplePos, this.sampleRate);
                this.samplePos = newSamplePos;
                this.state = 'DISCARDING';
                this.emit('discarded', start, discarded);
            }
        }

        if(startPaused) {
            this.state = 'PAUSED';
            this.pauseStartPos = this.samplePos;
            this.emit('paused');
        } else {
            this.state = 'STREAMING';
        }

        this._startMicrophoneCapture();
    }

    private _startMicrophoneCapture(): void {
        if (!recordModule || !this.selectedMedia) {
            console.error('[MediaSource] ERROR: Cannot start capture - recordModule:', !!recordModule, 'selectedMedia:', !!this.selectedMedia);
            return;
        }

        console.log('[MediaSource] Starting microphone capture...');

        this.microphoneRecorder = recordModule.record({
            sampleRate: this.sampleRate,
            channels: this.selectedMedia.channels.length,
            audioType: 'raw',
            encoding: 'signed-integer',
            bitDepth: 16,
        });

        const audioStream = this.microphoneRecorder.stream();

        audioStream.on('data', (data: Buffer) => {
            if (this.state !== 'STREAMING') return;

            if (this.frameCount === 0) {
                console.log('[MediaSource] First audio data received, length:', data.length);
            }

            // Convert L16 PCM buffer to Int16Array
            const l16Data = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
            
            // Convert to u-law (PCMU)
            const ulawData = ulawFromL16(l16Data);
            
            // Emit in frame-sized chunks (20ms = 160 samples at 8kHz)
            const samplesPerFrame = Math.trunc(this.frameDurationMs * this.sampleRate / 1000);
            
            for (let offset = 0; offset < ulawData.length; offset += samplesPerFrame) {
                const chunk = ulawData.slice(offset, Math.min(offset + samplesPerFrame, ulawData.length));
                
                if (chunk.length > 0) {
                    this.emit('audio', chunk);
                    this.samplePos += chunk.length;
                    this.frameCount++;
                    
                    // Log every logInterval frames
                    if (this.frameCount % this.logInterval === 0) {
                        console.log(`[Microphone] Sent ${this.frameCount} audio frames (${this.samplePos} samples)`);
                    }
                    
                    if (this.samplePos >= this.sampleEndPos) {
                        this._signalEnd();
                        return;
                    }
                }
            }
        });

        audioStream.on('error', (err: Error) => {
            this.emit('error', err);
        });

        // Emit end when microphone stops
        audioStream.on('end', () => {
            this._signalEnd();
        });
    }

    private _signalEnd(): void {
        if(this.microphoneRecorder) {
            this.microphoneRecorder.stop();
            this.microphoneRecorder = null;
        }
        if(this.audioTimer) {
            clearInterval(this.audioTimer);
            this.audioTimer = null;
        }
        if((this.state !== 'END') && (this.state !== 'CLOSED')) { 
            this.state = 'END';
            this.emit('end', StreamDuration.fromSamples(this.samplePos, this.sampleRate));
        }
    }

    async close(): Promise<void> {
        if (this.microphoneRecorder) {
            this.microphoneRecorder.stop();
            this.microphoneRecorder = null;
        }
        if(this.audioTimer) {
            clearInterval(this.audioTimer);
            this.audioTimer = null;
        }
        if(this.state !== 'CLOSED') {
            this.state = 'CLOSED';
            this.emit('closed');
        }
        this.removeAllListeners();
    }

    pause(): void {
        if(this.state === 'PAUSED') {
            this.emit('paused');
        } else if(this.state === 'STREAMING') {
            this.state = 'PAUSED';
            this.pauseStartPos = this.samplePos;
            if (this.microphoneRecorder) {
                this.microphoneRecorder.pause();
            }
            this.emit('paused');
        }
    }

    resume(): void {
        if(this.state === 'PAUSED') {
            this.state = 'STREAMING';
            if (this.microphoneRecorder) {
                this.microphoneRecorder.resume();
            }
            const start = StreamDuration.fromSamples(this.pauseStartPos, this.sampleRate);
            const discarded = StreamDuration.fromSamples(this.samplePos - this.pauseStartPos, this.sampleRate);
            this.emit('resumed', start, discarded);
        } else if(this.state === 'STREAMING') {
            this.emit('resumed', this.position, StreamDuration.zero);
        }
    }

    get position(): StreamDuration {
        return StreamDuration.fromSamples(this.samplePos, this.sampleRate);
    }

    override emit(eventName: 'audio', ...args: Parameters<OmitThisParameter<OnMediaSourceAudioHandler>>): boolean;
    override emit(eventName: 'discarded', ...args: Parameters<OmitThisParameter<OnMediaSourceDiscardedHandler>>): boolean;
    override emit(eventName: 'paused', ...args: Parameters<OmitThisParameter<OnMediaSourcePausedHandler>>): boolean;
    override emit(eventName: 'resumed', ...args: Parameters<OmitThisParameter<OnMediaSourceResumedHandler>>): boolean;
    override emit(eventName: 'end', ...args: Parameters<OmitThisParameter<OnMediaSourceEndHandler>>): boolean;
    override emit(eventName: 'error', ...args: Parameters<OmitThisParameter<OnMediaSourceErrorHandler>>): boolean;
    override emit(eventName: 'closed', ...args: Parameters<OmitThisParameter<OnMediaSourceClosedHandler>>): boolean;
    override emit(eventName: string, ...args: unknown[]): boolean {
        return super.emit(eventName, ...args);
    }
}

export const createMicrophoneMediaSource = (maxDuration?: StreamDuration): MediaSource => {
    return new MediaSourceMicrophone(maxDuration);
};
