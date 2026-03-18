const {createClient}=require('@supabase/supabase-js')
require('dotenv').config();

const supabaseURL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const supabaseAnonKey =
	process.env.VITE_SUPABASE_ANON_KEY ||
	process.env.SUPABASE_ANON_KEY ||
	process.env['VITE-SUPABASE_ANON_KEY']

if (!supabaseURL || !supabaseAnonKey) {
	throw new Error('Supabase credentials are missing in .env');
}

const supabase = createClient(supabaseURL, supabaseAnonKey)

module.exports=supabase