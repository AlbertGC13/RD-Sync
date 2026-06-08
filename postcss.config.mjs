// Tailwind v4 + Next.js App Router convention.
// The @tailwindcss/postcss plugin processes `@import "tailwindcss";`
// and the `@theme` block in src/app/globals.css into utility classes.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
