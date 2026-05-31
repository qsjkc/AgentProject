import api from './api'
import type {
  VoiceDemoSessionActionResponse,
  VoiceDemoSessionCreateResponse,
  VoiceDemoSessionStatusResponse,
  VoiceDemoStopResponse,
} from '../types'

export async function createVoiceDemoSession(): Promise<VoiceDemoSessionCreateResponse> {
  const response = await api.post('/rtc/voice-demo/session')
  return response.data
}

export async function startVoiceDemoSession(sessionId: string): Promise<VoiceDemoSessionActionResponse> {
  const response = await api.post(`/rtc/voice-demo/session/${sessionId}/start`)
  return response.data
}

export async function getVoiceDemoSession(sessionId: string): Promise<VoiceDemoSessionStatusResponse> {
  const response = await api.get(`/rtc/voice-demo/session/${sessionId}`)
  return response.data
}

export async function interruptVoiceDemoSession(sessionId: string): Promise<VoiceDemoSessionActionResponse> {
  const response = await api.post(`/rtc/voice-demo/session/${sessionId}/interrupt`)
  return response.data
}

export async function stopVoiceDemoSession(sessionId: string): Promise<VoiceDemoStopResponse> {
  const response = await api.post(`/rtc/voice-demo/session/${sessionId}/stop`)
  return response.data
}

export const voiceDemoApi = {
  createVoiceDemoSession,
  startVoiceDemoSession,
  getVoiceDemoSession,
  interruptVoiceDemoSession,
  stopVoiceDemoSession,
}
