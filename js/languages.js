// Target-language packs. The app UI is English; these hold what changes per
// language you're learning. Add a new entry here (plus a content/<code>/ folder
// and an ElevenLabs agent) to learn another language.
export const LANGUAGES = {
  it: {
    name: 'Italian',
    native: 'italiano',
    locale: 'it-IT',
    greetings: { morning: 'Buongiorno', afternoon: 'Buon pomeriggio', evening: 'Buonasera' },
    goalDone: 'Ottimo lavoro!',
    content: 'content/it/',
    coach: {
      name: 'Elena', // default coach; the name follows the chosen voice (see voices)
      // Public id of the private ElevenLabs agent. It's useless without the
      // API key, which lives only on your device (Settings).
      agentId: 'agent_2001m8c2gwahfvb96y5pwb1rhb7v',
      persona: `You are {name}, a warm, curious Italian conversation coach from {city} ({gender}). You speak ONLY Italian, at a natural native pace, as you would with a friend. Your learner is around B1 (speaking a bit weaker than reading) and wants to become fluent in real-life conversation.

General rules:
- Your turns are short (1 to 3 sentences) so the learner talks most of the time. Ask open follow-up questions.
- Do NOT correct mistakes out loud, and never switch to English. If the learner is stuck, rephrase more simply in Italian or offer two words to choose from.
- Each time the learner makes a clear, meaningful mistake (grammar, wrong word, unnatural phrasing), silently call the log_mistake tool once for it. Never mention that you are logging it. Ignore tiny slips and pronunciation.
- Use natural spoken Italian with common expressions and fillers (allora, cioè, dai, magari), but no heavy dialect.
- When the learner says goodbye or wants to stop, close warmly in one sentence and end the call.
- Messages that start with [APP] come from the learning app, not the learner. Follow them silently without mentioning the app.`,
      // Voices the coach can speak with (Settings → Coach voice). The first is the
      // default. Each one gets its own name and home town, so the persona fits.
      // `voice` is the ElevenLabs voice behind it. Prefer voices from the library's
      // "High quality" category: voices cloned from home recordings carry their
      // room noise and narrow, phone-like sound into everything they say.
      voices: [
        { key: 'simona', id: 'UnOINkXZ3yK4vVg3Iayj', name: 'Elena', voice: 'Beatrice', gender: 'female', city: 'Bologna', accent: 'Standard Italian' },
        { key: 'giulia', id: 'uC9VI5XrTxXRNlCzGSKR', name: 'Giulia', voice: 'Giulia', gender: 'female', city: 'Verona', accent: 'Standard Italian' },
        { key: 'paolo', id: '1s5ETcPtsJ9W2cUUQrDb', name: 'Paolo', voice: 'Luca', gender: 'male', city: 'Torino', accent: 'Standard Italian' },
        { key: 'roberta', id: '2bMAiYn9nNnA5AepoHYR', name: 'Roberta', voice: 'Sabrina', gender: 'female', city: 'Roma', accent: 'Rome' },
        { key: 'alice', id: 'yqYUuLveKQAg3xn3wYbI', name: 'Alice', voice: 'Alice', gender: 'female', city: 'Milano', accent: 'Milan' },
        { key: 'gianni', id: 'nH7uLS5UdEnvKEOAXtlQ', name: 'Gianni', voice: 'Vittorio', gender: 'male', city: 'Milano', accent: 'Milan' },
        { key: 'bernardo', id: 'GRjgv3Z8Gg3RY82Qo6FW', name: 'Bernardo', voice: 'Mike', gender: 'male', city: 'Firenze', accent: 'Florence' },
        { key: 'tatiana', id: '0agAAs6kdPUv4MFeK9wx', name: 'Tatiana', voice: 'Tatiana', gender: 'female', city: 'Napoli', accent: 'Naples, stronger accent' },
        { key: 'lodovico', id: 'uA5aGNikV4gcPbh3C2IT', name: 'Lodovico', voice: 'Lodovico', gender: 'male', city: 'Palermo', accent: 'Sicily, stronger accent' },
      ],
      wrapUp: '[APP] Less than a minute left. Bring the conversation to a natural close within your next two turns and say goodbye.',
    },
  },
};

export const DEFAULT_LANGUAGE = 'it';
export const lang = (code) => LANGUAGES[code] || LANGUAGES[DEFAULT_LANGUAGE];
