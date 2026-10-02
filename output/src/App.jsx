import React, { useState, useEffect } from 'react';

function useCityHistory() {
  const [history, setHistory] = useState(() => {
    const stored = localStorage.getItem('cityHistory');
    return stored ? JSON.parse(stored) : [];
  });

  useEffect(() => {
    localStorage.setItem('cityHistory', JSON.stringify(history));
  }, [history]);

  const addCity = (city) => {
    if (city && !history.includes(city)) {
      setHistory([...history, city]);
    }
  };

  return [history, addCity];
}

function useWeather(city) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!city) return;
    setLoading(true);
    const apiKey = '9ba884c10ca90d0ca1f8f0ec657c12b7';
    const fetchAll = async () => {
      try {
        const currentResp = await fetch(
          `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}`
        );
        if (!currentResp.ok) throw new Error('City not found');
        const current = await currentResp.json();

        const lat = current.coord.lat;
        const lon = current.coord.lon;
        const uvResp = await fetch(
          `https://api.openweathermap.org/data/2.5/uvi?lat=${lat}&lon=${lon}&appid=${apiKey}`
        );
        if (!uvResp.ok) throw new Error('UV fetch failed');
        const uvData = await uvResp.json();
        const uvIndex = uvData.value;

        const forecastResp = await fetch(
          `https://api.openweathermap.org/data/2.5/forecast?q=${city}&appid=${apiKey}`
        );
        if (!forecastResp.ok) throw new Error('Forecast not found');
        const forecast = await forecastResp.json();

        setData({ current, forecast, uvIndex });
        setError(null);
      } catch (err) {
        setError(err.message);
        setData(null);
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [city]);

  return { data, loading, error };
}

function App() {
  const [city, setCity] = useState('');
  const [history, addCity] = useCityHistory();
  const [heroImgSrc, setHeroImgSrc] = useState('');
  const [dateTime, setDateTime] = useState(new Date());
  const { data, loading, error } = useWeather(city);

  useEffect(() => {
    const imgArray = ['img/1.png', 'img/2.png', 'img/3.png', 'img/4.png', 'img/5.png'];
    const random = imgArray[Math.floor(Math.random() * imgArray.length)];
    setHeroImgSrc(random);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setDateTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formattedDate = `${dateTime.getMonth() + 1}/${dateTime.getDate()}/${dateTime.getFullYear()}`;

  const handleSearch = () => {
    alert('Button code executed.');
    if (city.trim()) {
      addCity(city);
      setCity('');
    }
  };

  const handleHistoryClick = (selectedCity) => {
    setCity(selectedCity);
  };

  let weatherInfo = null;
  if (data) {
    const { current, forecast, uvIndex } = data;
    const tempF = ((current.main.temp - 273.15) * 1.8 + 32).toFixed(2);
    const humidity = current.main.humidity;
    const windSpeed = (current.wind.speed * 2.236936).toFixed(1);
    const mainIcon = `https://openweathermap.org/img/wn/${current.weather[0].icon}.png`;

    let uvColor = 'green';
    if (uvIndex > 8) uvColor = 'red';
    else if (uvIndex > 6) uvColor = 'orange';
    else if (uvIndex > 3) uvColor = 'yellow';

    const forecastDays = [];
    if (forecast && forecast.list) {
      const list = forecast.list;
      const indices = [5, 13, 21, 29, 37];
      indices.forEach((idx, i) => {
        const item = list[idx];
        if (item) {
          const tempFDay = ((item.main.temp - 273.15) * 1.8 + 32).toFixed(2);
          const humidityDay = item.main.humidity;
          const iconDay = item.weather[0].icon;
          const dtTxt = item.dt_txt;
          const [datePart] = dtTxt.split(' ');
          const [yyyy, mm, dd] = datePart.split('-');
          const ddNoZero = dd.replace(/^0/, '');
          const formatted = `${mm}/${ddNoZero}/${yyyy}`;
          forecastDays.push({
            date: formatted,
            tempF: tempFDay,
            humidity: humidityDay,
            icon: iconDay,
          });
        }
      });
    }

    weatherInfo = (
      <>
        <div id="bigcity">{current.name}</div>
        <div id="mainIcon">
          <img src={mainIcon} alt="" />
        </div>
        <div className="tempF">Temperature: {tempF} °F</div>
        <div className="humidity">Humidity: {humidity}%</div>
        <div className="wind">Wind speed: {windSpeed} MPH</div>
        <div
          id="UV"
          style={{ backgroundColor: uvColor, color: '#fff', padding: '2px 6px' }}
        >
          {uvIndex}
        </div>

        <h3>5-Day Forecast:</h3>
        <div>
          {forecastDays.map((day, i) => (
            <div key={i} style={{ marginBottom: '1rem' }}>
              <div id={`fc-dt${i + 1}`}>{day.date}</div>
              <div id={`fc-temp${i + 1}`}>
                Temp: {day.tempF} °F
              </div>
              <div id={`smallIcon${i + 1}`}>
                <img
                  src={`https://openweathermap.org/img/wn/${day.icon}.png`}
                  alt=""
                />
              </div>
              <div id={`fc-humid${i + 1}`}>
                Humidity: {day.humidity}%
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      {/* Hero image */}
      <img id="hero" src={heroImgSrc} alt="hero" />

      {/* Clock */}
      <div id="clockbox">{formattedDate}</div>

      {/* Search input and button */}
      <input
        id="citysearch"
        type="text"
        value={city}
        onChange={(e) => setCity(e.target.value)}
        placeholder="Enter city"
      />
      <button id="myButton" onClick={handleSearch}>
        Search
      </button>

      {/* History containers */}
      <div id="history">
        {history.map((c) => (
          <button
            key={c}
            className="city"
            data-name={c}
            onClick={() => handleHistoryClick(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div id="mobileHistory">
        {history.map((c) => (
          <button
            key={c}
            className="city"
            data-name={c}
            onClick={() => handleHistoryClick(c)}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Weather info */}
      {loading ? (
        <p>Loading weather...</p>
      ) : error ? (
        <p>Error: {error}</p>
      ) : weatherInfo ? (
        weatherInfo
      ) : (
        <p>Enter a city to see weather.</p>
      )}
    </>
  );
}

export default App;