import { supabase } from '../../../lib/supabase';
import { normalizeTitle } from '../../../lib/utils/normalize';

const HEADERS = {
  'accept': '*/*',
  'authorization': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbiI6IjBmZDc1OWM2LTczMTYtNDdlZi1iZmYyLTg3ZWYwNTYxYWUxMCIsImlhdCI6MTc2MDQ3MDMzMX0.wkfUdwL5dZB3iPf_JeaLNI1GvtzqAXBntuu1AAtkwLk',
  'content-type': 'application/json',
  'origin': 'https://www.qfxcinemas.com',
  'referer': 'https://www.qfxcinemas.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

export default async function handler(req, res) {
  try {

    const listRes = await fetch('https://web-api.qfxcinemas.com/api/external/quick-book', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({})
    });
    const { movies } = await listRes.json();


    const uniqueMovies = Array.from(new Map(movies.map(m => [m.movie_id, m])).values());

    for (const movie of uniqueMovies) {
      const cleanTitle = normalizeTitle(movie.movie_title);


      const { data: movieRecord, error: mError } = await supabase
        .from('movies')
        .upsert({
          title: cleanTitle,
          poster_url: movie.MovieContent[0]?.artwork
        }, { onConflict: 'title' })
        .select().single();

      if (mError || !movieRecord) continue;


      const today = new Array(new Date().toISOString().split('T')[0]);
      const detailUrl = `https://web-api.qfxcinemas.com/api/cinema/admin/movie-confirmed-list/${movie.movie_id}?fromDate=${today}&city_id=29790`;

      const detailRes = await fetch(detailUrl, { headers: HEADERS });
      const detailData = await detailRes.json();

      const showtimeRecords = detailData.Records?.data || [];

      for (const show of showtimeRecords) {

        const { data: cinemaRecord } = await supabase
          .from('cinemas')
          .select('id')
          .eq('name', show.cine_name)
          .single();

        if (cinemaRecord) {
          await supabase.from('showtimes').upsert({
            movie_id: movieRecord.id,
            cinema_id: cinemaRecord.id,
            start_time: `${show.ss_start_date}T${show.ss_start_show_time}:00`,
            hall_name: show.screen_name,
            experience: show.mf_name,
            booking_url: `https://www.qfxcinemas.com/quick-ticket?showid=${show.schedule_id}`
          }, { onConflict: 'movie_id, cinema_id, start_time' });
        }
        if (!cinemaRecord) {
          console.log(`❌ No match found for: "${show.cine_name}". Showtime skipped.`);
          continue;
        }
      }
      console.log(`✅ Synced ${showtimeRecords.length} shows for ${cleanTitle}`);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}