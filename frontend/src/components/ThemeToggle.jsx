import { useState, useEffect } from 'react'
import { Sun, Moon } from 'lucide-react'

const STORAGE_KEY = 'driquiz_theme'

// Saved choice first; otherwise follow the operating system setting.
const systemTheme = () => {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch (_) {
    return 'dark'
  }
}

export const getCurrentTheme = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) || systemTheme()
  } catch (_) {
    return systemTheme()
  }
}

export const applyTheme = (theme) => {
  document.documentElement.setAttribute('data-theme', theme)
  try { localStorage.setItem(STORAGE_KEY, theme) } catch (_) {}
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(getCurrentTheme())

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggle = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }

  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle theme"
    >
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  )
}
