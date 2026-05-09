import { Routes, Route, useLocation } from 'react-router-dom'
import Navbar from './components/Navbar'
import Landing from './pages/Landing'
import CreateQuiz from './pages/CreateQuiz'
import History from './pages/History'
import PublicQuiz from './pages/PublicQuiz'

export default function App() {
  const location = useLocation()
  // Hide navbar on landing for cleaner hero
  const hideNavbar = location.pathname === '/'

  return (
    <>
      {!hideNavbar && <Navbar />}
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<CreateQuiz />} />
        <Route path="/history" element={<History />} />
        <Route path="/q/:quizId" element={<PublicQuiz />} />
      </Routes>
    </>
  )
}
