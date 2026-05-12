import { isSupabaseConfigured, supabase } from './supabase'

export async function listMatches() {
  if (!isSupabaseConfigured || !supabase) return []

  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .order('updated_at', { ascending: false })

  if (error) throw error
  return data || []
}

export async function upsertMatch(match) {
  if (!isSupabaseConfigured || !supabase || !match?.id) return null

  const payload = {
    app_match_id: match.id,
    name: `Match ${new Date(match.createdAt || Date.now()).toLocaleString()}`,
    result: match.completed ? 'Completed match' : 'Match in progress',
    overs: match.overs || null,
    updated_at: new Date().toISOString(),
    match_json: match,
  }

  const { data, error } = await supabase
    .from('matches')
    .upsert(payload, { onConflict: 'app_match_id' })
    .select()
    .single()

  if (error) throw error
  return data
}
