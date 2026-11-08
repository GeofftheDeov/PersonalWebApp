import AppShell from '@/components/shell/AppShell';

/**
 * The pages in the shell: the rail, the page and Letters. Your Quests and
 * Letters fill the shell's `quests` and `letters` slots in #221.
 */
export default function ShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}
