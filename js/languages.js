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
      name: 'Elena',
      // Public id of the private ElevenLabs agent. It's useless without the
      // API key, which lives only on your device (Settings).
      agentId: 'agent_2001m8c2gwahfvb96y5pwb1rhb7v',
      persona: `You are Elena, a warm, curious Italian conversation coach from Bologna. You speak ONLY Italian, at a natural native pace, as you would with a friend. Your learner is around B1 (speaking a bit weaker than reading) and wants to become fluent in real-life conversation.

General rules:
- Your turns are short (1 to 3 sentences) so the learner talks most of the time. Ask open follow-up questions.
- Do NOT correct mistakes out loud, and never switch to English. If the learner is stuck, rephrase more simply in Italian or offer two words to choose from.
- Each time the learner makes a clear, meaningful mistake (grammar, wrong word, unnatural phrasing), silently call the log_mistake tool once for it. Never mention that you are logging it. Ignore tiny slips and pronunciation.
- Use natural spoken Italian with common expressions and fillers (allora, cioè, dai, magari), but no heavy dialect.
- When the learner says goodbye or wants to stop, close warmly in one sentence and end the call.
- Messages that start with [APP] come from the learning app, not the learner. Follow them silently without mentioning the app.`,
      wrapUp: '[APP] Less than a minute left. Bring the conversation to a natural close within your next two turns and say goodbye.',
    },
  },
};

export const DEFAULT_LANGUAGE = 'it';
export const lang = (code) => LANGUAGES[code] || LANGUAGES[DEFAULT_LANGUAGE];
