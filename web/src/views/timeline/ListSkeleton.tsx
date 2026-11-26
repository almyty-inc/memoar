/** The session list before the archive answers, row for row the same size. */
export function ListSkeleton() {
  const widths = [62, 48, 71, 55, 66, 40, 58, 69, 51, 63, 45, 60];
  return (
    <div className="timeline-page" aria-busy="true" role="status" aria-label="Loading sessions">
      <div className="list-top">
        {/* Not a heading: the real one arrives with the list, and two would
            announce the page twice. */}
        <div className="page-header" aria-hidden="true"><p className="page-title">Sessions</p></div>
        <div className="list-toolbar"><span className="skeleton" style={{ width: 280, height: 28 }} /></div>
      </div>
      <div className="session-head" />
      {widths.map((width, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton" style={{ width: 64 }} />
          <span className="skeleton" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}
