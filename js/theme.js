/* Runs before paint so a dark viewer never sees a white flash. Separate file
 * because the page's CSP allows no inline script.
 */
if (matchMedia('(prefers-color-scheme: dark)').matches)
{
  document.documentElement.setAttribute('data-bs-theme', 'dark');
}

