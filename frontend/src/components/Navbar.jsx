import { useState, useEffect } from 'react'
import { NavLink, Link, useNavigate, useLocation } from 'react-router-dom'
import { Brain, GraduationCap, LogOut, User, Menu, X } from 'lucide-react'
import { getAuthTeacher, apiSignOut } from '../api'
import ThemeToggle from './ThemeToggle'

export default function Navbar() {
  const navigate = useNavigate()
  const location = useLocation()
  const [teacher, setTeacher] = useState(getAuthTeacher())
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // Close mobile nav whenever route changes
  useEffect(() => { setMobileNavOpen(false) }, [location.pathname])

  useEffect(() => {
    const onStorage = () => setTeacher(getAuthTeacher())
    window.addEventListener('storage', onStorage)
    const onFocus = () => setTeacher(getAuthTeacher())
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // Lock body scroll when mobile nav is open
  useEffect(() => {
    if (mobileNavOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [mobileNavOpen])

  const handleSignOut = async () => {
    await apiSignOut()
    setTeacher(null)
    setMenuOpen(false)
    setMobileNavOpen(false)
    navigate('/')
  }

  const navLinks = (
    <>
      <NavLink to="/app" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
        Create
      </NavLink>
      <NavLink to="/history" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
        History
      </NavLink>
      <NavLink to="/teacher" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
        <GraduationCap size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
        Teacher
      </NavLink>
      <NavLink to="/join" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
        Join class
      </NavLink>
    </>
  )

  return (
    <>
      <nav className="navbar">
        <Link to="/" className="navbar-brand">
          <span className="brand-icon">
            <Brain size={18} />
          </span>
          <span className="brand-text">Drilearn</span>
        </Link>

        {/* Desktop nav (hidden on mobile via CSS) */}
        <div className="navbar-links navbar-links-desktop">
          {navLinks}
          <ThemeToggle />
          {teacher ? (
            <div className="user-menu">
              <button className="user-button" onClick={() => setMenuOpen(o => !o)}>
                <User size={14} /> {teacher.name}
              </button>
              {menuOpen && (
                <>
                  <div className="user-menu-backdrop" onClick={() => setMenuOpen(false)} />
                  <div className="user-menu-popup">
                    <div className="user-menu-info">
                      <div className="user-menu-name">{teacher.name}</div>
                      <div className="user-menu-email">{teacher.email}</div>
                    </div>
                    <button className="user-menu-item" onClick={handleSignOut}>
                      <LogOut size={14} /> Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <NavLink to="/signin" className="nav-link nav-link-cta">
              Sign in
            </NavLink>
          )}
        </div>

        {/* Mobile: theme toggle + hamburger */}
        <div className="navbar-mobile-controls">
          <ThemeToggle />
          <button
            className="hamburger-btn"
            onClick={() => setMobileNavOpen(o => !o)}
            aria-label="Menu"
          >
            {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </nav>

      {/* Mobile drawer */}
      {mobileNavOpen && (
        <div className="mobile-nav-drawer">
          <div className="mobile-nav-content">
            {navLinks}
            <div className="mobile-nav-divider" />
            {teacher ? (
              <>
                <div className="mobile-nav-user">
                  <div className="user-menu-name">{teacher.name}</div>
                  <div className="user-menu-email">{teacher.email}</div>
                </div>
                <button className="nav-link mobile-nav-signout" onClick={handleSignOut}>
                  <LogOut size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                  Sign out
                </button>
              </>
            ) : (
              <NavLink to="/signin" className="nav-link nav-link-cta">
                Sign in
              </NavLink>
            )}
          </div>
        </div>
      )}
    </>
  )
}
