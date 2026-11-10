// Data for the free no-login aptitude practice pages (/free-aptitude-test).
// The tests run in the web app at SPA_BASE/<slug>. Sample items come from the retired public v1 pack.

export type SetSlug = 'easy' | 'medium' | 'hard';

export interface SampleItem {
  id: string;
  section: 'Quantitative' | 'Verbal';
  stem: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface FreeSet {
  slug: SetSlug;
  title: string;
  minutes: number;
  items: number;
  mix: { quantitative: number; logical: number; verbal: number };
  blurb: string;
  topics: { section: string; list: string[] }[];
  samples: SampleItem[];
  url: string;
}

export const SPA_BASE = 'https://assessiq.in/try/aptitude';

export const freeSets: FreeSet[] = [
  {
    slug: 'easy',
    title: 'Warm-up',
    minutes: 8,
    items: 10,
    mix: { quantitative: 4, logical: 3, verbal: 3 },
    blurb: 'Basic questions to start with. Good if you have not practised for a while.',
    topics: [
      { section: 'Quantitative', list: ['percentages', 'ratios', 'averages', 'simple interest'] },
      { section: 'Logical', list: ['number series', 'coding and decoding', 'directions'] },
      { section: 'Verbal', list: ['synonyms', 'antonyms', 'fill in the blank'] },
    ],
    samples: [
      {
        id: 'APT-Q-001', section: 'Quantitative', stem: 'What is 35% of 240?',
        options: ['72', '96', '84', '78'], correctIndex: 2,
        explanation: '35% of 240 = 35 × 240 ÷ 100 = 8400 ÷ 100 = 84.',
      },
      {
        id: 'APT-Q-041', section: 'Verbal', stem: 'Choose the word closest in meaning to ABUNDANT.',
        options: ['Plentiful', 'Scarce', 'Rare', 'Limited'], correctIndex: 0,
        explanation: 'Abundant means existing in large quantities, i.e. plentiful. The others mean the opposite.',
      },
    ],
    url: `${SPA_BASE}/easy`,
  },
  {
    slug: 'medium',
    title: 'Campus level',
    minutes: 10,
    items: 10,
    mix: { quantitative: 4, logical: 3, verbal: 3 },
    blurb: 'The level of many campus placement tests. Needs some working on paper.',
    topics: [
      { section: 'Quantitative', list: ['compound interest', 'time and distance', 'mixtures', 'percentages'] },
      { section: 'Logical', list: ['blood relations', 'ranking', 'series'] },
      { section: 'Verbal', list: ['synonyms', 'sentence correction', 'reading short passages'] },
    ],
    samples: [
      {
        id: 'APT-Q-011', section: 'Quantitative',
        stem: 'What is the compound interest on ₹8000 at 10% per annum for 2 years, compounded annually?',
        options: ['₹1600', '₹1700', '₹1680', '₹9680'], correctIndex: 2,
        explanation: 'Amount = 8000 × 1.1 × 1.1 = 9680. CI = 9680 − 8000 = ₹1680.',
      },
      {
        id: 'APT-Q-051', section: 'Verbal', stem: 'Choose the word closest in meaning to EPHEMERAL.',
        options: ['Short-lived', 'Eternal', 'Fragile', 'Ordinary'], correctIndex: 0,
        explanation: 'Ephemeral means lasting for a very short time, so short-lived. Eternal is the opposite.',
      },
    ],
    url: `${SPA_BASE}/medium`,
  },
  {
    slug: 'hard',
    title: 'Top scorer',
    minutes: 15,
    items: 10,
    mix: { quantitative: 4, logical: 3, verbal: 3 },
    blurb: 'Harder, multi-step questions. Try it after you finish the Campus level set.',
    topics: [
      { section: 'Quantitative', list: ['profit and loss', 'time and work', 'probability', 'permutations'] },
      { section: 'Logical', list: ['seating arrangements', 'syllogisms', 'puzzles'] },
      { section: 'Verbal', list: ['verbal ability'] },
    ],
    samples: [], // no samples on purpose: the questions in this set are new
    url: `${SPA_BASE}/hard`,
  },
];

export const mixText = (s: FreeSet) =>
  `${s.mix.quantitative} quantitative, ${s.mix.logical} logical, ${s.mix.verbal} verbal`;

/** Mock or Real mode copy shared by the hub and the set pages. Honest wording: Real is practice, not proctored, no camera. */
export const modeFaq = {
  q: 'What is Real mode?',
  a: 'Real mode shows the same test screen your candidates see: full screen where your browser allows it, a warning if you leave the window, and no answers until you ask. It is not proctored, nothing is recorded or sent, and the questions are public. It is without camera. Organisations can add a camera in their own assessments.',
};
export const realUrl = (url: string): string => `${url}?mode=real`;
