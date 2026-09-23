import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/features/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          hover: "hsl(var(--primary-hover))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        brand: {
          DEFAULT: "hsl(var(--brand))",
          dark: "hsl(var(--brand-dark))",
          ink: "hsl(var(--brand-ink))",
          cream: "hsl(var(--brand-cream))",
          paper: "hsl(var(--brand-paper))",
          line: "hsl(var(--brand-line))",
        },
      },
      fontFamily: {
        inter: ["var(--font-inter)", "sans-serif"],
        montserrat: ["var(--font-montserrat)", "sans-serif"],
      },
      borderRadius: {
        lg: "0px",
        md: "0px",
        sm: "0px",
        card: "12px",
        tile: "10px",
      },
      boxShadow: {
        soft: "0 8px 30px rgba(28, 28, 28, 0.06)",
      },
    },
  },
  plugins: [],
};

export default config;
