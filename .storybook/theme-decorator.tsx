import { useEffect, type ReactElement } from 'react';
import type { Decorator, Preview } from '@storybook/react-vite';

export type StoryTheme = 'dark' | 'light';
export type StoryContrast = 'normal' | 'more';

export const themeGlobalType: NonNullable<Preview['globalTypes']> = {
  theme: {
    description: 'First-party appearance',
    defaultValue: 'dark',
    toolbar: {
      icon: 'paintbrush',
      dynamicTitle: true,
      items: [
        { value: 'dark', title: 'Dark' },
        { value: 'light', title: 'Light' },
      ],
    },
  },
};

export const contrastGlobalType: NonNullable<Preview['globalTypes']> = {
  contrast: {
    description: 'Operating-system contrast preference',
    defaultValue: 'normal',
    toolbar: {
      icon: 'contrast',
      dynamicTitle: true,
      items: [
        { value: 'normal', title: 'Standard contrast' },
        { value: 'more', title: 'High contrast' },
      ],
    },
  },
};

function ThemeStory({
  theme,
  contrast,
  children,
}: {
  readonly theme: StoryTheme;
  readonly contrast: StoryContrast;
  readonly children: ReactElement;
}): ReactElement {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset['theme'] = theme;
    if (contrast === 'more') root.dataset['contrast'] = 'more';
    else delete root.dataset['contrast'];
    root.style.colorScheme = theme;
    return () => {
      delete root.dataset['theme'];
      delete root.dataset['contrast'];
      root.style.colorScheme = '';
    };
  }, [contrast, theme]);
  return children;
}

export const withTheme: Decorator = (Story, context) => {
  const theme = context.globals['theme'] === 'light' ? 'light' : 'dark';
  const contrast = context.globals['contrast'] === 'more' ? 'more' : 'normal';
  return (
    <ThemeStory theme={theme} contrast={contrast}>
      <Story />
    </ThemeStory>
  );
};
