import { Link } from 'react-router-dom';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export type TileProps = { title: string; value: number; total: number; listKey?: string; tone: Tone; hint?: string };

/** Ô số: có máy phía sau thì là liên kết tới trang danh sách riêng (URL chia sẻ được, nút Back hoạt động). */
export function Tile({ title, value, total, listKey, tone, hint }: TileProps) {
  const body = (
    <>
      <span className="tile-value">{value}</span>
      <span className="tile-title">{title}</span>
      {total > 0 && <span className="tile-sub">{Math.round((value / total) * 100)}% of {total}</span>}
    </>
  );
  if (listKey && value > 0) {
    return (
      <Link className={`tile ${tone}`} to={`/dashboard/${encodeURIComponent(listKey)}`} title={hint ?? 'Show these devices'}>
        {body}
      </Link>
    );
  }
  return <div className={`tile static ${tone}`} title={hint}>{body}</div>;
}
