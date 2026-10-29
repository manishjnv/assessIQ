// EXP-10 part 1: images and maths on the take page (option lists, stem images, practice question without an attempt).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { McqAnswerArea } from './McqAnswerArea.js';
import { MultiSelectAnswerArea } from './MultiSelectAnswerArea.js';
import { StemImages } from './rich-parts.js';

afterEach(() => cleanup());

const A1 = '0190a0a0-0000-7000-8000-0000000000a1';
const A2 = '0190a0a0-0000-7000-8000-0000000000a2';
const assets = [
  { id: A1, alt_text: 'Circuit with two switches', width: 320, height: 200 },
  { id: A2, alt_text: 'Option b: a router', width: 160, height: 120 },
];
const content = { question: 'Which?', options: ['fig a', 'fig b', 'fig c'], correct: 1, stem_assets: [A1], option_assets: [null, A2, null] };

const wrap = (ui: React.ReactElement, path = '/take/attempt/att1') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/take/attempt/:id" element={ui} /><Route path="*" element={ui} /></Routes>
    </MemoryRouter>,
  );

describe('option images', () => {
  it('an MCQ option shows its picture with the stored alt text, from the attempt route, and it is not a link', () => {
    wrap(<McqAnswerArea question={{ question_id: 'q1', content, assets }} answer={null} disabled={false} onAnswerChange={() => undefined} />);
    const img = screen.getByAltText('Option b: a router');
    expect(img.getAttribute('src')).toBe(`/api/me/attempts/att1/assets/${A2}`);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getAllByTestId('option-image')).toHaveLength(1);
    // the radio still works and its name includes the option text
    fireEvent.click(screen.getByRole('radio', { name: /fig b/ }));
    expect(screen.getByRole('radio', { name: /fig b/ })).toBeTruthy();
  });

  it('a multi-select option shows its picture too', () => {
    wrap(<MultiSelectAnswerArea question={{ question_id: 'q1', content, assets }} answer={null} disabled={false} onAnswerChange={() => undefined} />);
    expect(screen.getByAltText('Option b: a router')).toBeTruthy();
  });

  it('without metadata (no alt text) nothing is drawn; without an attempt in the url (practice question) nothing is drawn', () => {
    wrap(<McqAnswerArea question={{ question_id: 'q1', content }} answer={null} disabled={false} onAnswerChange={() => undefined} />);
    expect(screen.queryByRole('img')).toBeNull();
    cleanup();
    render(
      <MemoryRouter initialEntries={['/practice']}>
        <Routes><Route path="*" element={<McqAnswerArea question={{ question_id: 'q1', content, assets }} answer={null} disabled={false} onAnswerChange={() => undefined} />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('A21 the image route is the candidate attempt route and never the admin route or a stored path', () => {
    wrap(<McqAnswerArea question={{ question_id: 'q1', content, assets }} answer={null} disabled={false} onAnswerChange={() => undefined} />);
    const src = screen.getByAltText('Option b: a router').getAttribute('src')!;
    expect(src.startsWith('/api/me/attempts/')).toBe(true);
    expect(src).not.toContain('/admin/');
  });
});

describe('stem images', () => {
  it('a stem picture opens full size in a new tab and carries its alt text and size', () => {
    wrap(<StemImages q={{ content, assets }} />);
    const img = screen.getByAltText('Circuit with two switches');
    expect(img.getAttribute('width')).toBe('320');
    const link = screen.getByRole('link');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toBe(`/api/me/attempts/att1/assets/${A1}`);
  });

  it('an embed attempt whose image cannot load shows the alt text and a note, and the question stays answerable', () => {
    wrap(
      <>
        <StemImages q={{ content, assets }} />
        <McqAnswerArea question={{ question_id: 'q1', content, assets }} answer={null} disabled={false} onAnswerChange={() => undefined} />
      </>,
    );
    fireEvent.error(screen.getByAltText('Circuit with two switches'));
    const boxes = screen.getAllByTestId('question-image-fallback');
    expect(boxes[0]!.textContent).toContain('Circuit with two switches');
    expect(boxes[0]!.textContent).toContain('Image did not load');
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('no stem_assets means no picture block', () => {
    wrap(<StemImages q={{ content: { question: 'Q', options: ['a', 'b'], correct: 0 } }} />);
    expect(screen.queryByTestId('stem-images')).toBeNull();
  });
});

describe('maths in options', () => {
  it('with the flag an option formula is typeset; without it the text is untouched', async () => {
    const math = { question: 'q', options: ['\\(x^2\\)', 'plain'], correct: 0, math: true };
    const { container } = wrap(<McqAnswerArea question={{ question_id: 'q1', content: math }} answer={null} disabled={false} onAnswerChange={() => undefined} />);
    await waitFor(() => expect(container.querySelector('.katex')).toBeTruthy(), { timeout: 10_000 });
    cleanup();
    const plain = { ...math, math: undefined };
    const r2 = wrap(<McqAnswerArea question={{ question_id: 'q1', content: plain }} answer={null} disabled={false} onAnswerChange={() => undefined} />);
    expect(r2.container.querySelector('.katex')).toBeNull();
    expect(r2.container.textContent).toContain('\\(x^2\\)');
  });
});
