import { downloadMediaMessage, proto, WASocket } from '@whiskeysockets/baileys';

const DEFAULT_MODEL = 'whisper-1';
const FALLBACK_MESSAGE = '[Voice Message - transcription unavailable]';

export function isVoiceMessage(msg: proto.IWebMessageInfo): boolean {
  return msg.message?.audioMessage?.ptt === true;
}

async function transcribeWithOpenAI(audioBuffer: Buffer): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('OPENAI_API_KEY not configured for transcription');
    return null;
  }

  const model = process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_MODEL;
  const FormDataCtor = (globalThis as any).FormData;
  const BlobCtor = (globalThis as any).Blob;
  const form = new FormDataCtor();
  const blob = new BlobCtor([audioBuffer], { type: 'audio/ogg' });
  form.append('file', blob, 'voice.ogg');
  form.append('model', model);
  form.append('response_format', 'text');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`OpenAI transcription failed (${response.status}): ${errorText}`);
    return null;
  }

  const text = await response.text();
  return text.trim();
}

export async function transcribeAudioMessage(
  msg: proto.IWebMessageInfo,
  sock: WASocket,
): Promise<string | null> {
  try {
    const buffer = (await downloadMediaMessage(
      msg as any,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return FALLBACK_MESSAGE;
    }

    const transcript = await transcribeWithOpenAI(buffer);
    if (!transcript) return FALLBACK_MESSAGE;

    return transcript;
  } catch (err) {
    console.error('Transcription error:', err);
    return FALLBACK_MESSAGE;
  }
}
