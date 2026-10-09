import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';

dotenv.config();

const {
    OPENAI_API_KEY,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    PHONE_NUMBER_FROM,
    DOMAIN,
    AGENT_API_KEY
} = process.env;

if (
    !OPENAI_API_KEY ||
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !PHONE_NUMBER_FROM ||
    !DOMAIN ||
    !AGENT_API_KEY
) {
    console.error(
        'Missing OPENAI_API_KEY, Twilio credentials, PHONE_NUMBER_FROM, DOMAIN, or AGENT_API_KEY.'
    );
    process.exit(1);
}

const MODEL = 'gpt-live-1';
const DELEGATED_MODEL = 'gpt-5.6-terra';
const VOICE = 'marin';
const USER_AGENT = 'twilio-demos/Node 1.0.0';
const PORT = process.env.PORT || 5050;

const HOST = DOMAIN
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');

const MAX_TASK_LENGTH = 450;

const OPENING =
    'السلام عليكم، معك المساعد الصوتي بالذكاء الاصطناعي الخاص بسلطان.';

const VOICE_PROMPT = `
أنت المساعد الصوتي الشخصي الخاص بسلطان.

تحدث دائماً باللغة العربية وبلهجة خليجية طبيعية وواضحة.
استخدم أسلوباً ودياً ومختصراً يناسب المكالمات الهاتفية.
لا تتحدث بالإنجليزية إلا إذا طلب الطرف الآخر ذلك.

تحدث بسرعة محادثة طبيعية ولا تطل في الرد.
تفاعل بسرعة عندما يتوقف الطرف الآخر عن الكلام.

إذا قاطعك الطرف الآخر أثناء كلامك، توقف واستمع له ثم أكمل بناءً على كلامه.

أنت مساعد صوتي بالذكاء الاصطناعي يعمل بالنيابة عن سلطان.
لا تدّع أنك سلطان.
ولا تدّع أنك إنسان إذا تم سؤالك مباشرة.

لكل مكالمة قد تكون هناك مهمة محددة.
ركز على تنفيذ المهمة الحالية ولا تخرج عنها بدون حاجة.

إذا كنت تتصل بمطعم أو شركة أو شخص لتنفيذ طلب، عرّف بنفسك باختصار ثم ابدأ في تنفيذ المهمة بشكل طبيعي.

إذا لم تفهم كلام الطرف الآخر، اطلب منه إعادة الكلام باختصار.

لا تخترع معلومات غير موجودة.
لا توافق على أي دفع أو التزام مالي بدون موافقة صريحة من سلطان.
لا تؤكد حجزاً أو موعداً إلا بعد التأكد من التاريخ والوقت والتفاصيل.

إذا لم يكن الخيار المطلوب متوفراً، يمكنك السؤال عن البدائل المناسبة، لكن لا توافق على تغيير جوهري بدون الرجوع إلى سلطان.
`;

const BACKEND_PROMPT = `
أنت العقل الخلفي للمساعد الصوتي الخاص بسلطان.

ساعد المساعد الصوتي على تنفيذ المهمة الحالية بدقة.
استخدم المعلومات المتاحة فقط.
لا تخترع معلومات أو تفاصيل غير مؤكدة.

إذا كانت هناك حاجة إلى البحث عن معلومة عامة متاحة على الإنترنت، استخدم أداة البحث عند الحاجة.

أجب بالعربية وباختصار لأن النتيجة ستستخدم أثناء مكالمة هاتفية.

لا توافق على دفع أو التزام مالي بالنيابة عن سلطان بدون موافقته الصريحة.
`;

const TOOLS = [
    {
        type: 'web_search'
    }
];

const client = twilio(
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN
);

const makeCall = async (to, task) => {
    if (!/^\+[1-9]\d{6,14}$/.test(to)) {
        throw new Error(
            'Invalid phone number. Use E.164 format, for example +974XXXXXXXX.'
        );
    }

    if (!task || typeof task !== 'string' || !task.trim()) {
        throw new Error('Task is required.');
    }

    const cleanTask = task.trim();

    if (cleanTask.length > MAX_TASK_LENGTH) {
        throw new Error(
            `Task is too long. Maximum length is ${MAX_TASK_LENGTH} characters.`
        );
    }

    const response = new twilio.twiml.VoiceResponse();

    const connect = response.connect();

    const stream = connect.stream({
        url: `wss://${HOST}/media-stream`
    });

    stream.parameter({
        name: 'task',
        value: cleanTask
    });

    const call = await client.calls.create({
        from: PHONE_NUMBER_FROM,
        to,
        twiml: response.toString(),

        // SAFETY LIMIT:
        // Force Twilio to end the call after 5 minutes maximum.
        timeLimit: 300
    });

    console.log(
        `Started outbound call to ${to} — ${call.sid}`
    );

    return call;
};

const fastify = Fastify();

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

/*
 * Simple health check.
 */
fastify.get('/health', async () => {
    return {
        ok: true,
        service: 'Sultan Voice Agent'
    };
});

/*
 * API used by n8n to start a phone call.
 *
 * POST /api/call
 *
 * Header:
 * x-agent-key: YOUR_AGENT_API_KEY
 *
 * Body:
 * {
 *   "phoneNumber": "+974XXXXXXXX",
 *   "task": "المهمة المطلوبة"
 * }
 */
fastify.post('/api/call', async (request, reply) => {
    const apiKey = request.headers['x-agent-key'];

    if (apiKey !== AGENT_API_KEY) {
        return reply.code(401).send({
            success: false,
            error: 'Unauthorized'
        });
    }

    const {
        phoneNumber,
        task
    } = request.body || {};

    if (!phoneNumber) {
        return reply.code(400).send({
            success: false,
            error: 'phoneNumber is required'
        });
    }

    if (!task) {
        return reply.code(400).send({
            success: false,
            error: 'task is required'
        });
    }

    try {
        const call = await makeCall(
            phoneNumber,
            task
        );

        return reply.code(200).send({
            success: true,
            callSid: call.sid,
            status: call.status || 'queued',
            phoneNumber
        });
    } catch (error) {
        console.error(
            'Error starting outbound call:',
            error
        );

        return reply.code(500).send({
            success: false,
            error: error.message
        });
    }
});

fastify.register(async (fastify) => {
    fastify.get(
        '/media-stream',
        {
            websocket: true
        },
        (connection) => {
            console.log(
                'Call answered, media stream connected'
            );

            let streamSid = null;
            let callSid = null;
            let callTask = '';

            let sessionRequested = false;
            let sessionReady = false;

            /*
             * Prevent duplicate cleanup / hangup attempts.
             */
            let closing = false;
            let endingTwilioCall = false;

            /*
             * Becomes true when Twilio itself tells us the stream
             * ended normally.
             */
            let twilioStopReceived = false;

            const openAiWs = new WebSocket(
                'wss://api.openai.com/v1/live/sessions',
                {
                    headers: {
                        Authorization:
                            `Bearer ${OPENAI_API_KEY}`,
                        'User-Agent': USER_AGENT
                    }
                }
            );

            const send = (event) => {
                if (
                    openAiWs.readyState ===
                    WebSocket.OPEN
                ) {
                    openAiWs.send(
                        JSON.stringify(event)
                    );
                }
            };

            /*
             * Close local WebSocket connections.
             */
            const close = () => {
                if (closing) {
                    return;
                }

                closing = true;
                sessionReady = false;

                try {
                    if (
                        connection.readyState ===
                        WebSocket.OPEN
                    ) {
                        connection.close();
                    }
                } catch (error) {
                    console.error(
                        'Error closing Twilio socket:',
                        error
                    );
                }

                try {
                    if (
                        openAiWs.readyState ===
                        WebSocket.OPEN ||
                        openAiWs.readyState ===
                        WebSocket.CONNECTING
                    ) {
                        openAiWs.close();
                    }
                } catch (error) {
                    console.error(
                        'Error closing OpenAI socket:',
                        error
                    );
                }
            };

            /*
             * IMPORTANT SAFETY FUNCTION
             *
             * If the Media Stream or GPT-Live connection dies
             * unexpectedly, explicitly tell Twilio to terminate
             * the phone call.
             *
             * This protects against a call remaining active
             * even after the voice WebSocket disappears.
             */
            const endTwilioCall = async (reason = 'unknown') => {
                if (
                    !callSid ||
                    endingTwilioCall ||
                    twilioStopReceived
                ) {
                    return;
                }

                endingTwilioCall = true;

                console.log(
                    `Force ending Twilio call ${callSid}. Reason: ${reason}`
                );

                try {
                    await client
                        .calls(callSid)
                        .update({
                            status: 'completed'
                        });

                    console.log(
                        `Twilio call ${callSid} ended successfully.`
                    );
                } catch (error) {
                    /*
                     * If Twilio already ended the call, the update
                     * may fail. That is harmless, so log it only.
                     */
                    console.error(
                        'Error force-ending Twilio call:',
                        error.message
                    );
                }
            };

            /*
             * Wait until:
             * 1. Twilio has supplied streamSid
             * 2. We have received the task
             * 3. OpenAI WebSocket is connected
             */
            const startSession = () => {
                if (
                    sessionRequested ||
                    !streamSid ||
                    openAiWs.readyState !==
                        WebSocket.OPEN
                ) {
                    return;
                }

                sessionRequested = true;

                const taskInstructions = callTask
                    ? `
المهمة الحالية في هذه المكالمة:

${callTask}

نفذ هذه المهمة أثناء المكالمة.

ابدأ بالتعريف بنفسك باختصار ثم انتقل مباشرة إلى سبب الاتصال.

لا تسأل الطرف الآخر "كيف أقدر أخدمك؟" لأنك أنت من أجريت الاتصال لتنفيذ مهمة محددة.

إذا أعطاك الطرف الآخر نتيجة أو تأكيداً، تأكد من التفاصيل المهمة قبل إنهاء المكالمة.

إذا احتاج الأمر إلى دفع أو التزام مالي أو تغيير جوهري عن المطلوب، لا توافق عليه بدون موافقة سلطان.
`
                    : `
لا توجد مهمة محددة لهذه المكالمة.
تحدث بشكل طبيعي مع الطرف الآخر.
`;

                const liveInstructions = `
${VOICE_PROMPT}

${taskInstructions}
`;

                const backendInstructions = `
${BACKEND_PROMPT}

المهمة الحالية للمكالمة:
${callTask || 'لا توجد مهمة محددة.'}
`;

                send({
                    type: 'session.start',

                    session: {
                        model: MODEL,

                        instructions:
                            liveInstructions,

                        audio: {
                            format: {
                                type: 'audio/pcmu',
                                rate: 8000
                            },

                            output: {
                                voice: VOICE
                            }
                        },

                        delegation: {
                            type: 'responses',

                            responses: {
                                model:
                                    DELEGATED_MODEL,

                                instructions:
                                    backendInstructions,

                                tools: TOOLS
                            }
                        }
                    }
                });
            };

            openAiWs.on('open', () => {
                console.log(
                    'Connected to GPT-Live-1'
                );

                startSession();
            });

            openAiWs.on(
                'message',
                async (rawData) => {
                    try {
                        const event = JSON.parse(
                            rawData.toString()
                        );

                        if (
                            event.type ===
                            'session.started'
                        ) {
                            sessionReady = true;

                            console.log(
                                'GPT-Live-1 session',
                                event.session?.id
                            );

                            send({
                                type:
                                    'session.instructions.append',

                                delegation_id: null,

                                content:
                                    `الجملة الأولى التي تقولها في هذه المكالمة حرفياً هي: "${OPENING}"`
                            });

                            send({
                                type:
                                    'session.commentary.append',

                                delegation_id: null,

                                content: OPENING
                            });
                        }

                        else if (
                            event.type ===
                                'session.output_audio.delta' &&
                            streamSid &&
                            connection.readyState ===
                                WebSocket.OPEN
                        ) {
                            connection.send(
                                JSON.stringify({
                                    event: 'media',
                                    streamSid,

                                    media: {
                                        payload:
                                            event.delta
                                    }
                                })
                            );
                        }

                        else if (
                            event.type ===
                            'session.output_transcript.delta'
                        ) {
                            console.log(
                                'Assistant:',
                                event.delta
                            );
                        }

                        else if (
                            event.type === 'error'
                        ) {
                            console.error(
                                'GPT-Live-1 error:',
                                event.error
                            );
                        }
                    } catch (error) {
                        console.error(
                            'Error processing GPT-Live-1 message:',
                            error
                        );
                    }
                }
            );

            connection.on(
                'message',
                (rawMessage) => {
                    try {
                        const data = JSON.parse(
                            rawMessage.toString()
                        );

                        if (
                            data.event === 'start'
                        ) {
                            streamSid =
                                data.start.streamSid;

                            callSid =
                                data.start.callSid ||
                                null;

                            callTask =
                                data.start
                                    .customParameters
                                    ?.task || '';

                            console.log(
                                'Outgoing stream has started',
                                streamSid
                            );

                            if (callSid) {
                                console.log(
                                    'Twilio call:',
                                    callSid
                                );
                            }

                            console.log(
                                'Task received:',
                                callTask
                                    ? 'yes'
                                    : 'no'
                            );

                            startSession();
                        }

                        else if (
                            data.event === 'media' &&
                            sessionReady &&
                            openAiWs.readyState ===
                                WebSocket.OPEN
                        ) {
                            send({
                                type:
                                    'session.input_audio.append',

                                audio:
                                    data.media.payload
                            });
                        }

                        else if (
                            data.event === 'stop'
                        ) {
                            /*
                             * Twilio says the stream ended normally.
                             *
                             * Do NOT send another hangup request here.
                             */
                            twilioStopReceived = true;

                            console.log(
                                'Twilio sent stream stop event.'
                            );

                            close();
                        }
                    } catch (error) {
                        console.error(
                            'Error parsing Twilio message:',
                            error
                        );
                    }
                }
            );

            /*
             * If Twilio's WebSocket disappears WITHOUT first
             * sending a normal stop event, explicitly terminate
             * the Twilio phone call.
             */
            connection.on(
                'close',
                async () => {
                    console.log(
                        'Twilio media stream closed.'
                    );

                    if (!twilioStopReceived) {
                        await endTwilioCall(
                            'Twilio media stream closed unexpectedly'
                        );
                    }

                    close();

                    console.log(
                        'Call ended.'
                    );
                }
            );

            connection.on(
                'error',
                async (error) => {
                    console.error(
                        'Twilio WebSocket error:',
                        error
                    );

                    await endTwilioCall(
                        'Twilio WebSocket error'
                    );

                    close();
                }
            );

            /*
             * If GPT-Live disconnects unexpectedly while Twilio's
             * call is still running, explicitly end the phone call.
             */
            openAiWs.on(
                'close',
                async (code, reason) => {
                    console.log(
                        'Disconnected from GPT-Live-1',
                        code,
                        reason.toString()
                    );

                    if (
                        !twilioStopReceived &&
                        !closing
                    ) {
                        await endTwilioCall(
                            'GPT-Live-1 WebSocket closed'
                        );
                    }

                    close();
                }
            );

            openAiWs.on(
                'error',
                async (error) => {
                    console.error(
                        'Error in OpenAI WebSocket:',
                        error
                    );

                    await endTwilioCall(
                        'GPT-Live-1 WebSocket error'
                    );

                    close();
                }
            );
        }
    );
});

/*
 * Start the service.
 * It will NOT make a call automatically.
 * It waits for POST /api/call.
 */
fastify.listen(
    {
        port: PORT,
        host: '::'
    },
    (err) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }

        console.log(
            `Server is listening on port ${PORT}`
        );

        console.log(
            'Waiting for /api/call requests...'
        );
    }
);
