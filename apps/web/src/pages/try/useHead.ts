import { useEffect } from 'react';

/** Document title and canonical link for a public /try page. Both are removed on unmount. */
export function useHead(title: string, canonical: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.href = canonical;
    document.head.appendChild(link);
    return () => {
      document.title = prev;
      link.remove();
    };
  }, [title, canonical]);
}
