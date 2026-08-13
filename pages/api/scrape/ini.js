import { sendAlert } from "../../../lib/utils/alert.js";
import { supabase } from "../../../lib/supabase.js";
import { normalizeTitle } from "../../../lib/utils/normalize.js";

export const dynamic = "force-dynamic";

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    console.log("🚀 Starting INI Cinemas v1 Scrape...");

    // 1. Fetch active dates from INI REST API
    const datesRes = await fetch("https://api-prod.inicinemas.com/api/v1/shows/active-dates");
    if (!datesRes.ok) {
      throw new Error(`Failed to fetch active dates from INI API (Status ${datesRes.status})`);
    }
    const datesJson = await datesRes.json();
    const datesArray = datesJson.data || datesJson || [];
    const activeDates = Array.isArray(datesArray) ? datesArray.slice(0, 5) : [];

    if (activeDates.length === 0) {
      console.log("No active dates found for INI Cinemas.");
      return res.status(200).json({ success: true, message: "No active dates found." });
    }

    console.log(`📅 Scraping INI Cinemas for dates: ${activeDates.join(", ")}`);

    // 2. Fetch existing cinemas from Supabase DB
    const { data: allCinemas, error: cineError } = await supabase
      .from("cinemas")
      .select("id, mall_name, chain_name, location_url");

    if (cineError || !allCinemas) {
      throw new Error(`Could not load cinemas from DB: ${cineError?.message}`);
    }

    let totalShowsProcessed = 0;

    for (const dateStr of activeDates) {
      console.log(`\n🔍 Fetching INI schedule for date: ${dateStr}`);
      const schedRes = await fetch(`https://api-prod.inicinemas.com/api/v1/shows/city-schedule?date=${dateStr}`);

      if (!schedRes.ok) {
        console.error(`❌ Failed schedule fetch for date ${dateStr}: ${schedRes.status}`);
        continue;
      }

      const schedJson = await schedRes.json();
      const scheduleData = schedJson.data || schedJson || {};
      if (!scheduleData || typeof scheduleData !== "object") continue;

      const locationKeys = Object.keys(scheduleData);

      for (const locId of locationKeys) {
        const shows = scheduleData[locId];
        if (!Array.isArray(shows) || shows.length === 0) continue;

        for (const show of shows) {
          if (!show.movie || !show.movie.title) continue;

          const locationName = show.location_name ? show.location_name.trim() : "iNi Cinemas";
          const rawMovieTitle = show.movie.title;
          const cleanTitle = normalizeTitle(rawMovieTitle);

          // Movie details mapping
          const posterUrl = show.movie.movie_poster || show.movie.movie_banner || null;
          const genre = show.movie.genre || null;
          const duration = show.movie.duration ? parseInt(show.movie.duration, 10) : null;
          const synopsis = show.movie.description || null;
          const director = show.movie.director || null;

          const { data: movieRecord, error: mError } = await supabase
            .from("movies")
            .upsert(
              {
                title: cleanTitle,
                poster_url: posterUrl,
                genre: genre,
                duration: duration,
                synopsis: synopsis,
                director: director,
              },
              { onConflict: "title" }
            )
            .select()
            .single();

          if (mError || !movieRecord) {
            console.error(`⏩ Skipping movie ${cleanTitle}: ${mError?.message}`);
            continue;
          }

          // Cinema matching & auto-creation
          const fullLocationName = locationName.startsWith("iNi") || locationName.startsWith("Ini")
            ? locationName
            : `Ini Cinemas - ${locationName}`;

          let cinemaMatch = allCinemas.find((dbCine) => {
            const dbNameClean = dbCine.mall_name ? dbCine.mall_name.toLowerCase().trim() : "";
            const locNameClean = fullLocationName.toLowerCase().trim();
            const locShortClean = locationName.toLowerCase().trim();
            return (
              dbNameClean === locNameClean ||
              dbNameClean === locShortClean ||
              dbNameClean.includes(locShortClean) ||
              locShortClean.includes(dbNameClean)
            );
          });

          if (!cinemaMatch) {
            console.log(`✨ Creating missing INI Cinema in DB: "${fullLocationName}"`);
            const { data: newCinema, error: createErr } = await supabase
              .from("cinemas")
              .insert({
                mall_name: fullLocationName,
                chain_name: "Ini Cinemas",
              })
              .select()
              .single();

            if (createErr || !newCinema) {
              console.error(`❌ Failed to auto-create cinema "${fullLocationName}":`, createErr?.message);
              continue;
            } else {
              console.log(`✅ Successfully created cinema: "${newCinema.mall_name}"`);
              cinemaMatch = newCinema;
              allCinemas.push(newCinema);
            }
          }

          // Format start time string (e.g. "2026-07-28T11:30:00")
          const startTimeIso = `${show.show_date}T${show.start_time}`;

          // Calculate ticket price
          const showDateObj = new Date(show.show_date);
          const dayOfWeek = showDateObj.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
          const startHour = parseInt(show.start_time.split(":")[0], 10);
          const isMorning = startHour < 12;
          const isDealDay = dayOfWeek === 2 || dayOfWeek === 3;
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 5 || dayOfWeek === 6;

          let ticketPrice = null;
          const locLower = fullLocationName.toLowerCase();

          if (locLower.includes("lotse")) {
            if (isDealDay) ticketPrice = 200;
            else if (isWeekend) ticketPrice = isMorning ? 200 : 400;
            else ticketPrice = isMorning ? 165 : 330;
          } else if (locLower.includes("bishwojyoti")) {
            if (isDealDay) ticketPrice = 200;
            else if (isWeekend) ticketPrice = isMorning ? 175 : 350;
            else ticketPrice = isMorning ? 150 : 300;
          } else if (locLower.includes("nb") || locLower.includes("baneshwor")) {
            if (isDealDay) ticketPrice = 200;
            else if (isWeekend) ticketPrice = isMorning ? 225 : 450;
            else ticketPrice = isMorning ? 175 : 350;
          } else if (locLower.includes("butwal")) {
            if (isDealDay) ticketPrice = 180;
            else if (isWeekend) ticketPrice = isMorning ? 175 : 350;
            else ticketPrice = isMorning ? 145 : 290;
          } else if (locLower.includes("simara") || locLower.includes("devchuli") || locLower.includes("bhairahawa")) {
            if (isDealDay) ticketPrice = 150;
            else if (isWeekend) ticketPrice = isMorning ? 150 : 300;
            else ticketPrice = isMorning ? 125 : 250;
          }

          const movieSlug = cleanTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');

          const bookingUrl = `https://inicinemas.com/movie/${movieSlug}?date=${show.show_date}`;

          const { error: sError } = await supabase.from("showtimes").upsert(
            {
              movie_id: movieRecord.id,
              cinema_id: cinemaMatch.id,
              start_time: startTimeIso,
              price: ticketPrice,
              booking_url: bookingUrl,
            },
            { onConflict: "movie_id, cinema_id, start_time" }
          );

          if (sError) {
            console.error(`❌ DB Error for ${cleanTitle} at ${fullLocationName}:`, sError.message);
          } else {
            totalShowsProcessed++;
          }
        }
      }
    }

    console.log(`✅ INI Cinemas Sync Completed. Processed ${totalShowsProcessed} showtimes.`);

    return res.status(200).json({
      success: true,
      message: `INI Cinemas sync completed successfully. Processed ${totalShowsProcessed} showtimes.`,
    });
  } catch (error) {
    console.error("💥 Critical INI Scraper Error:", error.message);
    await sendAlert(`Critical error in ini.js: ${error.message}`);
    return res.status(200).json({ success: false, error: error.message });
  }
}
