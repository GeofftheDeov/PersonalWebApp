import Letters from '@/components/letters/Letters';
import YourQuests from '@/components/quests/YourQuests';
import AppShell from '@/components/shell/AppShell';

/**
 * The pages in the shell: the rail (with Your Quests), the page and Letters
 * (#221). LettersProvider, in the root layout (#251), holds which thread
 * Letters has open, so it lasts across page changes and a page or the top
 * bar can open one (`useLetters()`).
 */
export default function ShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AppShell quests={<YourQuests />} letters={<Letters />}>{children}</AppShell>;
}
