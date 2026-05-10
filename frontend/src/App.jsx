import { Routes, Route, useLocation } from 'react-router-dom'
import Navbar from './components/Navbar'
import Landing from './pages/Landing'
import CreateQuiz from './pages/CreateQuiz'
import History from './pages/History'
import PublicQuiz from './pages/PublicQuiz'
import Flashcards from './pages/Flashcards'
import StudyNotes from './pages/StudyNotes'
import TeacherDashboard from './pages/teacher/TeacherDashboard'
import ClassDetail from './pages/teacher/ClassDetail'
import AssignmentAnalytics from './pages/teacher/AssignmentAnalytics'
import JoinClass from './pages/JoinClass'
import StudentClass from './pages/StudentClass'
import AssignmentTake from './pages/AssignmentTake'

export default function App() {
  const location = useLocation()
  const hideNavbar = location.pathname === '/'

  return (
    <>
      {!hideNavbar && <Navbar />}
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<CreateQuiz />} />
        <Route path="/history" element={<History />} />
        <Route path="/q/:quizId" element={<PublicQuiz />} />
        <Route path="/flashcards/:setId" element={<Flashcards />} />
        <Route path="/notes/:noteId" element={<StudyNotes />} />

        {/* Teacher routes */}
        <Route path="/teacher" element={<TeacherDashboard />} />
        <Route path="/teacher/class/:classId" element={<ClassDetail />} />
        <Route path="/teacher/assignment/:assignmentId/analytics" element={<AssignmentAnalytics />} />

        {/* Student routes */}
        <Route path="/join" element={<JoinClass />} />
        <Route path="/join/:code" element={<JoinClass />} />
        <Route path="/student/class/:classId" element={<StudentClass />} />
        <Route path="/assignment/:assignmentId" element={<AssignmentTake />} />
      </Routes>
    </>
  )
}
