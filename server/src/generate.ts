// Writing new content with Claude: articles, listening clips, speaking scenes and
// conversation cards, in the same JSON shapes as content/it/*.json.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Kind } from './plan.ts';
import { topicLabel } from './plan.ts';
import articlesJson from '../../content/it/articles.json' with { type: 'json' };
import clipsJson from '../../content/it/clips.json' with { type: 'json' };
import scenesJson from '../../content/it/scenes.json' with { type: 'json' };
import cardsJson from '../../content/it/cards.json' with { type: 'json' };

export const BUILTIN = { articles: articlesJson as any[], clips: clipsJson as any, scenes: scenesJson as any[], cards: cardsJson as any[] };

const LEVELS = ['A2', 'A2–B1', 'B1', 'B1–B2', 'B2', 'B2–C1'] as const;
const TOPIC_KEYS = ['food', 'travel', 'work', 'society', 'culture', 'health', 'home', 'city', 'services', 'personal', 'leisure', 'everyday', 'tech'] as const;

export type Brief = {
  kind: Kind;
  topic: string;          // topic key (js/recommend.js TOPICS)
  level: string;          // CEFR label to write at
  focus: string[];        // grammar categories from the mistake log to weave in
  avoidTitles: string[];  // titles that already exist, so nothing repeats
};

const LEARNER = `The learner: an adult Dutch speaker living in Amsterdam, learning Italian for real life in Italy. Around B1 overall: speaking a bit lower, reading a bit higher, real-speed listening is the weak spot. They want natural, current Italian as people actually speak and write it, not textbook Italian.`;

function common(b: Brief): string {
  return [
    LEARNER,
    `Topic area: ${topicLabel(b.topic)} (key "${b.topic}"). Choose a specific, interesting angle within it; something an Italian would genuinely talk or read about.`,
    `Write at CEFR level ${b.level}: mostly high-frequency words, so the learner knows about 95 to 98% of them, with a handful of useful new words that the context makes guessable.`,
    b.focus.length ? `The learner keeps making mistakes with: ${b.focus.join(', ')}. Use these structures naturally and more often than usual, without drawing attention to them.` : '',
    b.avoidTitles.length ? `Don't repeat these existing titles or their angle: ${b.avoidTitles.slice(-40).join(' | ')}` : '',
  ].filter(Boolean).join('\n\n');
}

// ---- schemas (validated again after parsing: sizes, answer indexes) ----
const ArticleS = z.object({
  title: z.string(),
  topic_label: z.string().describe('One Italian word or two for the topic, like "Cibo", "Società", "Lavoro"'),
  level: z.enum(LEVELS),
  minutes: z.number().int(),
  paragraphs: z.array(z.string()),
  glossary: z.array(z.object({ word: z.string(), meaning: z.string().describe('Short English meaning') })),
  discussion: z.array(z.string()).describe('Key points for the coach to discuss, in English'),
});
const voiceKeys = Object.keys(BUILTIN.clips.voices) as [string, ...string[]];
const ClipS = z.object({
  title: z.string(),
  genre: z.string().describe('English, like "Dialogue", "Voicemail", "Radio news", "Podcast", "Story", "Announcement"'),
  level: z.enum(LEVELS),
  segments: z.array(z.object({ voice: z.enum(voiceKeys), text: z.string() })),
  questions: z.array(z.object({ q: z.string(), options: z.array(z.string()), answer: z.number().int().describe('Index of the right option, from 0') })),
  dictation: z.string().describe('One sentence copied exactly, character for character, from one of the segments'),
});
const SceneS = z.object({
  title: z.string(),
  subtitle: z.string().describe('Short English description'),
  icon: z.string().describe('One emoji'),
  minutes: z.number().int(),
  level: z.enum(LEVELS),
  firstMessage: z.string().describe('The coach\'s first line, in Italian'),
  instructions: z.string().describe('Role-play brief for the coach, in English'),
});
const CardsS = z.object({
  cards: z.array(z.object({ text: z.string(), type: z.enum(['quick', 'deep']), topics: z.array(z.enum(TOPIC_KEYS)) })),
});

function task(b: Brief): { schema: z.ZodType; prompt: string } {
  const c = common(b);
  if (b.kind === 'article') {
    const ex = BUILTIN.articles[0];
    return { schema: ArticleS, prompt: `${c}

Write a reading article with some depth (550 to 800 words, 5 to 7 paragraphs), like a good Italian magazine piece: concrete facts, people, places, a real tension or question, not a list. Then 8 to 12 glossary entries for the hardest useful words, and 4 to 6 key points (in English) that a coach can use to check understanding and start a discussion. "minutes" is the reading time.

The style and shape to match (an existing article):
${JSON.stringify({ title: ex.title, topic_label: ex.topic, level: ex.level, minutes: ex.minutes, paragraphs: ex.paragraphs.slice(0, 2), glossary: ex.glossary.slice(0, 3).map(([word, meaning]: string[]) => ({ word, meaning })), discussion: ex.discussion.slice(0, 2) }, null, 1)}` };
  }
  if (b.kind === 'clip') {
    const ex = BUILTIN.clips.clips[2];
    const voices = Object.entries(BUILTIN.clips.voices).map(([k, v]: [string, any]) => `${k} (${v.name}, ${v.accent})`).join(', ');
    return { schema: ClipS, prompt: `${c}

Write a listening clip of 2 to 4 minutes spoken (about 280 to 450 words in total): a dialogue, voicemail, radio item, short podcast or announcement, as real people speak: fillers (allora, cioè, dai, insomma), interruptions, short sentences, some regional flavour. Up to 3 speakers; each segment is one turn or one block of speech by one voice. Voices (use the key; pick names that fit the voice's gender and city): ${voices}.
Then exactly 4 multiple-choice questions in Italian about the meaning (3 or 4 options each, one right; "answer" is its index), testing details a distracted listener would miss. "dictation" is one sentence of 8 to 16 words copied exactly from a segment.

An existing clip, for shape:
${JSON.stringify({ title: ex.title, genre: ex.genre, level: ex.level, segments: ex.segments.slice(0, 3), questions: ex.questions.slice(0, 1), dictation: ex.dictation }, null, 1)}` };
  }
  if (b.kind === 'scene') {
    const ex = BUILTIN.scenes[2];
    return { schema: SceneS, prompt: `${c}

Write a speaking scene: a role play the voice coach plays with the learner, for a real situation in Italy that fits the topic (for practical topics, a situation with a small problem to solve). 8 to 12 minutes. "instructions" tells the coach who they play, the situation, 2 or 3 complications to bring in, and to keep turns short so the learner talks most. "firstMessage" opens the scene in character.

An existing scene, for shape:
${JSON.stringify({ title: ex.title, subtitle: ex.subtitle, icon: ex.icon, minutes: ex.minutes, level: ex.level, firstMessage: ex.firstMessage, instructions: ex.instructions }, null, 1)}` };
  }
  return { schema: CardsS, prompt: `${c}

Write 20 new conversation cards (questions or prompts in Italian, addressed to the learner with "tu"), like the cards a tutor uses: 12 "quick" ones (answer in a sentence or two) and 8 "deep" ones (talk about it for a few minutes: opinions, stories, hypotheticals). Lean toward the topic area, but mix in a few others. Tag each with 1 or 2 topic keys.

Existing cards, for shape (don't repeat these): ${JSON.stringify(BUILTIN.cards.slice(18, 24))}` };
}

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Check and tidy a generated item; throws when it isn't usable. */
export function finish(kind: Kind, raw: any, b: Brief, now: number): { id: string; data: any } {
  const id = `g${new Date(now).toISOString().slice(2, 10).replace(/-/g, '')}-${slug(raw.title || kind) || kind}`;
  const topics = [b.topic];
  if (kind === 'article') {
    if (raw.paragraphs.length < 3 || raw.glossary.length < 4) throw new Error('article too short');
    return { id, data: { id, title: raw.title, topic: raw.topic_label, level: raw.level, minutes: Math.max(2, Math.min(15, raw.minutes)), topics,
      paragraphs: raw.paragraphs, glossary: raw.glossary.map((g: any) => [g.word, g.meaning]), discussion: raw.discussion } };
  }
  if (kind === 'clip') {
    if (raw.segments.length < 1 || raw.questions.length < 2) throw new Error('clip too short');
    const questions = raw.questions.filter((q: any) => q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
    if (questions.length < 2) throw new Error('clip questions invalid');
    let dictation = String(raw.dictation || '').trim();
    if (!raw.segments.some((s: any) => s.text.includes(dictation))) {
      // Fall back to a sentence of a usable length from the clip itself.
      const sentences = raw.segments.flatMap((s: any) => s.text.match(/[^.!?]+[.!?]/g) || []).map((x: string) => x.trim());
      dictation = sentences.find((x: string) => { const n = x.split(/\s+/).length; return n >= 7 && n <= 18; }) || sentences[0] || '';
    }
    if (!dictation) throw new Error('clip has no dictation sentence');
    return { id, data: { id, title: raw.title, genre: raw.genre, level: raw.level, topics, segments: raw.segments, questions, dictation } };
  }
  if (kind === 'scene') {
    return { id, data: { id, title: raw.title, subtitle: raw.subtitle, icon: [...String(raw.icon || '💬')].slice(0, 2).join(''), minutes: Math.max(6, Math.min(15, raw.minutes)), level: raw.level, topics, firstMessage: raw.firstMessage, instructions: raw.instructions } };
  }
  const cards = raw.cards.filter((x: any) => x.text && (x.type === 'quick' || x.type === 'deep'));
  if (cards.length < 8) throw new Error('too few cards');
  return { id, data: { id, cards } };
}

/** Ask Claude for one item. Returns the parsed object and token usage. */
export async function write(client: Anthropic, model: string, b: Brief): Promise<{ raw: any; usage: { input: number; output: number } }> {
  const { schema, prompt } = task(b);
  const res = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // if a safety check declines, the API retries on a suitable model
    output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
    system: 'You write learning material for an Italian language app. Your Italian is natural, idiomatic and correct; level and length instructions are firm.',
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to write this item');
  if (res.stop_reason === 'max_tokens') throw new Error('Output was cut off');
  if (!res.parsed_output) throw new Error('Output did not match the schema');
  return { raw: res.parsed_output, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
}
