/** The session list before the archive answers, row for row the same size. */
export function ListSkeleton() {
  const widths = [62, 48, 71, 55, 66, 40, 58, 69];
  return (
    <div className="timeline-page" aria-busy="true" role="status" aria-label="Loading sessions">
      <div className="list-top">
        {/* Not a heading: the real one arrives with the list, and two would
            announce the page twice. */}
        <div className="page-header" aria-hidden="true"><p className="page-title">Sessions</p></div>
        <span className="skeleton" style={{ width: 260, height: 30, borderRadius: 999 }} />
      </div>
      {widths.map((width, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton skeleton-mark" />
          <span className="skeleton-lines">
            <span className="skeleton" style={{ width: `${width}%`, height: 12 }} />
            <span className="skeleton" style={{ width: '92%' }} />
            <span className="skeleton" style={{ width: '40%' }} />
          </span>
        </div>
      ))}
    </div>
  );
}
