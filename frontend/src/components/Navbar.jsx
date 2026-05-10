import { useState, useEffect } from 'react'
import { NavLink, Link, useNavigate } from 'react-router-dom'
import { Brain, GraduationCap, LogOut, User } from 'lucide-react'
import { getAuthTeacher, apiSignOut } from '../api'

export default function Navbar() {
  const navigate = useNavigate()
  const [teacher, setTeacher] = useState(getAuthTeacher())
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    // Re-read teacher on every navigation in case sign-in happened in another tab
    const onStorage = () => setTeacher(getAuthTeacher())
    window.addEventListener('storage', onStorage)
    // Also poll on focus to catch same-tab changes after auth
    const onFocus = () => setTeacher(getAuthTeacher())
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const handleSignOut = async () => {
    await apiSignOut()
    setTeacher(null)
    setMenuOpen(false)
    navigate('/')
  }

  return (
    <nav className="navbar">
      <Link to="/" className="navbar-brand">
        <span className="brand-icon">
          <Brain size={18} />
        </span>
        <span className="brand-text">DriQuiz</span>
      </Link>
      <div className="navbar-links">
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
    </nav>
  )
}
