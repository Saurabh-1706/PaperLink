/**
 * Nav destinations that exist as routes but have no screen designed yet.
 * One component so the empty states stay consistent instead of drifting.
 */
export default function PlaceholderPage({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="animate-fade-in-up flex flex-1 flex-col items-center justify-center gap-4 px-gutter py-24 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-container/10 text-primary">
        <span className="material-symbols-outlined text-[40px]">{icon}</span>
      </div>
      <h1 className="font-headline-lg text-on-surface tracking-tight">{title}</h1>
      <p className="font-body-md text-on-surface-variant max-w-md">{description}</p>
    </div>
  );
}
