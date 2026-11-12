import Letters from '@/components/letters/Letters';
import { LettersProvider } from '@/components/letters/LettersProvider';
import YourQuests from '@/components/quests/YourQuests';
import AppShell from '@/components/shell/AppShell';

/**
 * The pages in the shell: the rail (with Your Quests), the page and Letters
 * (#221). LettersProvider holds which thread Letters has open, so it lasts
 * across page changes and a page can open one (`useLetters()`).
 */
export default function ShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <LettersProvider>
      <AppShell quests={<YourQuests />} letters={<Letters />}>{children}</AppShell>
    </LettersProvider>
  );
}
