// Target-language packs. The app UI is English; these hold what changes per
// language you're learning. Add a new entry here to learn another language.
export const LANGUAGES = {
  it: {
    name: 'Italian',
    native: 'italiano',
    locale: 'it-IT',
    greetings: { morning: 'Buongiorno', afternoon: 'Buon pomeriggio', evening: 'Buonasera' },
    goalDone: 'Ottimo lavoro!',
  },
};

export const DEFAULT_LANGUAGE = 'it';
export const lang = (code) => LANGUAGES[code] || LANGUAGES[DEFAULT_LANGUAGE];
