import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';

dotenv.config();

const {
    OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PHONE_NUMBER_FROM, DOMAIN
} = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PHONE_NUMBER_FROM || !DOMAIN) {
    console.error('Missing OPENAI_API_KEY, Twilio credentials, PHONE_NUMBER_FROM, or DOMAIN in the .env file.');
    process.exit(1);
}

const TO = process.argv.find((arg) => arg.startsWith('--call='))?.split('=')[1];

if (!TO) {
    console.error('Usage: node outbound-demo.js --call=+18885551212');
    process.exit(1);
}

// Defensive: fail on definitely malformed non-E.164 input before Twilio sees it.
if (!/^\+[1-9]\d{6,14}$/.test(TO)) {
    console.error(`--call=${TO} is not an E.164 phone number.`);
    process.exit(1);
}

const MODEL = 'gpt-live-1';
const DELEGATED_MODEL = 'gpt-5.6-terra';
const VOICE = 'marin';
const USER_AGENT = 'twilio-demos/Node 1.0.0';
const PORT = process.env.PORT || 5050;
const HOST = DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '');

// Replace the array with business logic to look up if you can call based on jurisdiction.
const OVERRIDE_NUMBERS = [];

const OPENING = "Hi, this is Owlie calling back – I'm an AI voice assistant powered by Twilio and OpenAI's GPT-Live. Ready when you are.";
const VOICE_PROMPT = "You are Owlie, an AI voice assistant powered by Twilio and OpenAI's GPT-Live, returning a call. "
    + 'Never call yourself ChatGPT. '
    + 'You are cheerful, with a penchant for dad jokes, owl jokes, and subtle rickrolling. '
    + 'Do not claim to know the callback note until get_callback_reason has returned a result.';
const BACKEND_PROMPT = 'Use get_callback_reason for the callback note and web_search for facts. Answer in one or two sentences.';

const TOOLS = [
    { type: 'web_search' },
    {
        type: 'function',
        name: 'get_callback_reason',
        description: 'Look up the note attached to this callback.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
];

const NOTES = [
    'Your flight is on time. I checked twice. I will check again.',
    'Your table is ready, and I told them you prefer the booth by the window.',
    'Your package arrives Thursday. The driver has been briefed about the driveway.',
    'Your prescription is ready, along with a 17-inch-long receipt.',
    'Your appointment moved up an hour, which I spotted an hour before they called you. '
        + 'I asked them to send you a reminder and a reminder about the reminder, to be safe.',
    'Your order shipped, and I have been refreshing the tracking page on your behalf.',
];

// Mock tool call, slow on purpose.
const getCallbackReason = async () => {
    console.log("Consulting Owlie's notes...");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return { note: NOTES[Math.floor(Math.random() * NOTES.length)] };
};

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const makeCall = async (to) => {
    if (!OVERRIDE_NUMBERS.includes(to)) {
        const [owned, verified] = await Promise.all([
            client.incomingPhoneNumbers.list({ phoneNumber: to }),
            client.outgoingCallerIds.list({ phoneNumber: to })
        ]);
        if (!owned.length && !verified.length) {
            console.error(`${to} is not a Twilio number on this account or a verified caller ID.`);
            process.exit(1);
        }
    }

    const call = await client.calls.create({
        from: PHONE_NUMBER_FROM,
        to,
        twiml: `<Response><Connect><Stream url="wss://${HOST}/media-stream" /></Connect></Response>`
    });
    console.log(`Returning ${to}'s call — ${call.sid}`);
};

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection) => {
        console.log('Call answered, media stream connected');

        let streamSid = null;
        let sessionRequested = false;
        let sessionReady = false;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/live/sessions', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'User-Agent': USER_AGENT
            }
        });

        const send = (event) => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.send(JSON.stringify(event));
        };
        const close = () => {
            sessionReady = false;
            connection.close();
            openAiWs.close();
        };

        // Wait for Twilio's stream ID before starting the session.
        const startSession = () => {
            if (sessionRequested || !streamSid || openAiWs.readyState !== WebSocket.OPEN) return;
            sessionRequested = true;
            send({ type: 'session.start', session: {
                model: MODEL,
                instructions: VOICE_PROMPT,
                audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: VOICE } },
                delegation: {
                    type: 'responses',
                    responses: { model: DELEGATED_MODEL, instructions: BACKEND_PROMPT, tools: TOOLS }
                }
            } });
        };

        openAiWs.on('open', () => {
            console.log('Connected to GPT-Live-1');
            startSession();
        });

        openAiWs.on('message', async (data) => {
            try {
                const event = JSON.parse(data);

                if (event.type === 'session.started') {
                    sessionReady = true;
                    // Quote this ID if you ever need OpenAI's help with a call.
                    console.log('GPT-Live-1 session', event.session?.id);
                    send({ type: 'session.instructions.append', delegation_id: null,
                        content: `Your first spoken line on this call is, verbatim: "${OPENING}"` });
                    send({ type: 'session.commentary.append', delegation_id: null, content: OPENING });
                } else if (event.type === 'session.output_audio.delta' && streamSid && connection.readyState === WebSocket.OPEN) {
                    connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
                } else if (event.type === 'response.event'
                    && event.event?.type === 'response.output_item.done'
                    && event.event.item?.type === 'function_call' && event.event.item.status === 'completed') {
                    const { call_id, name, arguments: args } = event.event.item;
                    console.log('Tool call:', name, args);
                    const output = name === 'get_callback_reason'
                        ? await getCallbackReason()
                        : { error: 'unknown tool' };
                    send({ type: 'response.item.create',
                        item: { type: 'function_call_output', call_id, output: JSON.stringify(output) } });
                    send({ type: 'response.create' });
                } else if (event.type === 'session.output_transcript.delta') {
                    console.log('Assistant:', event.delta);
                } else if (event.type === 'error') {
                    console.error('GPT-Live-1 error:', event.error);
                }
            } catch (error) { console.error('Error processing the GPT-Live-1 message:', error); }
        });

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                if (data.event === 'media' && sessionReady && openAiWs.readyState === WebSocket.OPEN) {
                    send({ type: 'session.input_audio.append', audio: data.media.payload });
                } else if (data.event === 'start') {
                    streamSid = data.start.streamSid;
                    console.log('Outgoing stream has started', streamSid);
                    startSession();
                } else if (data.event === 'stop') {
                    close();
                }
            } catch (error) { console.error('Error parsing Twilio message:', error); }
        });

        connection.on('close', () => { close(); console.log('Call ended.'); });
        connection.on('error', close);
        openAiWs.on('close', (code, reason) => {
            close();
            console.log('Disconnected from GPT-Live-1', code, reason.toString());
        });
        openAiWs.on('error', (error) => { console.error('Error in the OpenAI WebSocket:', error); close(); });
    });
});

fastify.listen({ port: PORT, host: "::" }, async (err) => {
    if (err) { console.error(err); process.exit(1); }
    console.log(`Server is listening on port ${PORT}`);
    await makeCall(TO);
});
