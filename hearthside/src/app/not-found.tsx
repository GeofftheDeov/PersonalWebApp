import Link from 'next/link';

/** A path Hearthside doesn't have: on the floor, with the way home. */
export default function NotFound() {
  return (
    <div className="hs-shell-wrap">
      <header className="hs-page-head">
        <h1>Nothing here</h1>
        <p>
          That page isn&rsquo;t on the board. <Link href="/">Back to the Hearth</Link>
        </p>
      </header>
    </div>
  );
}
