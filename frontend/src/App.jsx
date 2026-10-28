import { Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import RequireAuth from './components/RequireAuth'
import Landing from './pages/Landing'
import CreateQuiz from './pages/CreateQuiz'
import History from './pages/History'
import PublicQuiz from './pages/PublicQuiz'
import Flashcards from './pages/Flashcards'
import StudyNotes from './pages/StudyNotes'
import SignIn from './pages/SignIn'
import TeacherDashboard from './pages/teacher/TeacherDashboard'
import ClassDetail from './pages/teacher/ClassDetail'
import AssignmentAnalytics from './pages/teacher/AssignmentAnalytics'
import JoinClass from './pages/JoinClass'
import StudentClass from './pages/StudentClass'
import AssignmentTake from './pages/AssignmentTake'
import LiveHost from './pages/live/LiveHost'
import LiveJoin from './pages/live/LiveJoin'
import LivePlay from './pages/live/LivePlay'
import Start from './pages/Start'
import MyProgress from './pages/MyProgress'
import AdminDashboard from './pages/AdminDashboard'
import AdminUser from './pages/AdminUser'

export default function App() {
  return (
    <>
      <Navbar />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/start" element={<Start />} />
        <Route path="/app" element={<CreateQuiz />} />
        <Route path="/history" element={<History />} />
        <Route path="/q/:quizId" element={<PublicQuiz />} />
        <Route path="/flashcards/:setId" element={<Flashcards />} />
        <Route path="/notes/:noteId" element={<StudyNotes />} />

        <Route path="/signin" element={<SignIn />} />

        {/* Any signed-in account */}
        <Route path="/my" element={<RequireAuth><MyProgress /></RequireAuth>} />

        {/* Teacher routes (teacher or admin account) */}
        <Route path="/teacher" element={<RequireAuth role="teacher"><TeacherDashboard /></RequireAuth>} />
        <Route path="/teacher/class/:classId" element={<RequireAuth role="teacher"><ClassDetail /></RequireAuth>} />
        <Route path="/teacher/assignment/:assignmentId/analytics" element={<RequireAuth role="teacher"><AssignmentAnalytics /></RequireAuth>} />
        <Route path="/live/host/:sessionId" element={<RequireAuth role="teacher"><LiveHost /></RequireAuth>} />

        {/* Administration */}
        <Route path="/admin" element={<RequireAuth role="admin"><AdminDashboard /></RequireAuth>} />
        <Route path="/admin/users/:userId" element={<RequireAuth role="admin"><AdminUser /></RequireAuth>} />

        {/* Student routes (open) */}
        <Route path="/join" element={<JoinClass />} />
        <Route path="/join/:code" element={<JoinClass />} />
        <Route path="/student/class/:classId" element={<StudentClass />} />
        <Route path="/assignment/:assignmentId" element={<AssignmentTake />} />
        <Route path="/live" element={<LiveJoin />} />
        <Route path="/live/:code" element={<LiveJoin />} />
        <Route path="/live/play/:sessionId" element={<LivePlay />} />
      </Routes>
    </>
  )
}
