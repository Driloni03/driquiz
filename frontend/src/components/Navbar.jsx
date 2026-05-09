import { NavLink, Link } from 'react-router-dom'
import { Brain } from 'lucide-react'

export default function Navbar() {
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
      </div>
    </nav>
  )
}
