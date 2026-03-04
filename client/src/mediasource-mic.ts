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

    constructor(maxDuration?: StreamDuration) {
        super();
        const channels: MediaChannels[] = [['external'], ['internal']];
        this.offeredMedia = channels.map(channels => ({ 
            type: 'audio', 
            format: 'L16', // 16-bit linear PCM for microphone
            channels, 
            rate: this.sampleRate 
        }));
        this.sampleEndPos = Math.trunc((maxDuration?.seconds ?? 7*24*3600) * this.sampleRate);
    }

    startStreaming(selectedMedia: MediaParameter | null, discardTo?: StreamDuration, startPaused?: boolean): void {
        if(this.state !== 'PREPARING') {
            throw new Error(`Cannot start stream in state '${this.state}'`);
        }

        if (!recordModule) {
            this.state = 'CLOSED';
            this.emit('error', new Error('node-record-lpcm16 not installed. Run: npm install node-record-lpcm16'));
            return;
        }

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
        if (!recordModule || !this.selectedMedia) return;

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

            const samplesPerFrame = Math.trunc(this.frameDurationMs * this.sampleRate / 1000);
            const bytesPerFrame = samplesPerFrame * 2 * (this.selectedMedia?.channels.length ?? 1); // 16-bit = 2 bytes

            // Process data in frame-sized chunks
            for (let offset = 0; offset < data.length; offset += bytesPerFrame) {
                const chunk = data.slice(offset, Math.min(offset + bytesPerFrame, data.length));
                const sampleCount = Math.trunc(chunk.length / 2 / (this.selectedMedia?.channels.length ?? 1));
                
                if (sampleCount > 0) {
                    this.emit('audio', new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                    this.samplePos += sampleCount;
                    
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
