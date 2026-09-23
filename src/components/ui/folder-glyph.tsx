import { cn } from "@/lib/utils/cn";

export function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 14" fill="none" aria-hidden="true" className={cn("h-12 w-auto", className)}>
      <path
        d="M16.299 1.79424H9.07247L7.63501 0.0883548C7.58665 0.0303156 7.51419 -0.00223361 7.43864 0.000119331H1.6083C0.718139 0.00658992 0 0.728943 0 1.61777V12.1099C0.00108006 13.0018 0.724914 13.7245 1.61812 13.7256H16.299C17.1922 13.7245 17.9161 13.0018 17.9171 12.1099V3.40992C17.9161 2.51806 17.1922 1.79532 16.299 1.79424Z"
        fill="#F2994A"
      />
    </svg>
  );
}
