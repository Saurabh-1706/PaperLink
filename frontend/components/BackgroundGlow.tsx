"use client";

// Decorative blurred ellipses behind the floating app shell, matching the
// Figma "Upload Screen - Empty State" background treatment.
export default function BackgroundGlow() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute h-[428px] w-[1318px] rounded-full bg-[rgba(23,23,23,0.4)]"
        style={{ filter: "blur(200px)", left: "10%", top: "10%" }}
      />
      <div
        className="absolute h-[428px] w-[1113px] rounded-full bg-[rgba(76,76,76,0.4)]"
        style={{ filter: "blur(200px)", left: "5%", bottom: "5%" }}
      />
    </div>
  );
}
