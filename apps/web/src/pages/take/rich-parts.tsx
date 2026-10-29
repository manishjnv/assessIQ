// EXP-10 part 1: images and maths on the take page. Small pieces shared by the stem (Attempt.tsx) and the option lists
// (McqAnswerArea, MultiSelectAnswerArea). Image bytes come from the attempt-scoped route; alt text and size come from
// the question's `assets` list that the server sends with the attempt. Nothing here draws raw html.
import { useParams } from 'react-router';
import { MathText, QuestionImage } from '@assessiq/ui-system';

interface AssetMeta { id: string; alt_text: string; width: number; height: number }
interface RichQuestion { content: unknown; assets?: AssetMeta[] | undefined }

const contentOf = (q: RichQuestion): Record<string, unknown> =>
  q.content !== null && typeof q.content === 'object' && !Array.isArray(q.content) ? (q.content as Record<string, unknown>) : {};

/** content.math === true; anything else draws plain text. */
export const isMath = (q: RichQuestion): boolean => contentOf(q)['math'] === true;

/** The route that serves one image of the running attempt; null when there is no attempt id in the url (practice question). */
function useAssetUrl(): (assetId: string) => string | null {
  const { id } = useParams<{ id: string }>();
  return (assetId) => (id !== undefined && id !== '' ? `/api/me/attempts/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}` : null);
}

function ImageById({ q, assetId, linked, maxHeight }: { q: RichQuestion; assetId: string; linked: boolean; maxHeight?: number }): React.JSX.Element | null {
  const url = useAssetUrl()(assetId);
  const meta = q.assets?.find((a) => a.id === assetId);
  // No metadata means no alt text: draw nothing rather than an image a screen reader cannot describe.
  if (url === null || meta === undefined) return null;
  return <QuestionImage src={url} alt={meta.alt_text} width={meta.width} height={meta.height} linked={linked} {...(maxHeight !== undefined ? { maxHeight } : {})} />;
}

/** Text of the stem or an option: LaTeX is drawn only when the question carries the math flag. */
export function RichText({ q, text }: { q: RichQuestion; text: string }): React.JSX.Element {
  return <MathText text={text} math={isMath(q)} />;
}

export function StemImages({ q }: { q: RichQuestion }): React.JSX.Element | null {
  const ids = contentOf(q)['stem_assets'];
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return (
    <div className="aiq-take-qimgs" data-testid="stem-images" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '12px 0' }}>
      {ids.filter((x): x is string => typeof x === 'string').map((id) => (
        <ImageById key={id} q={q} assetId={id} linked />
      ))}
    </div>
  );
}

export function OptionImage({ q, idx }: { q: RichQuestion; idx: number }): React.JSX.Element | null {
  const arr = contentOf(q)['option_assets'];
  const id = Array.isArray(arr) ? arr[idx] : undefined;
  if (typeof id !== 'string') return null;
  return (
    <span className="aiq-take-opt-img" data-testid="option-image" style={{ display: 'block', marginTop: 8 }}>
      <ImageById q={q} assetId={id} linked={false} maxHeight={160} />
    </span>
  );
}
