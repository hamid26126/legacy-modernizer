import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';

function App() {
  const [tasks, setTasks] = useState([]);
  const [showingCompletedOnly, setShowingCompletedOnly] = useState(false);
  const inputRef = useRef();

  const filteredTasks = showingCompletedOnly
    ? tasks.filter(t => t.completed)
    : tasks;

  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const remaining = total - completed;
  const statsText = `Total: ${total} | Completed: ${completed} | Remaining: ${remaining}`;

  useEffect(() => {
    fetch('https://jsonplaceholder.typicode.com/todos?_limit=3')
      .then(res => res.json())
      .then(data => {
        setTasks(
          data.map(item => ({
            id: String(item.id),
            title: item.title,
            completed: item.completed,
          }))
        );
      });
  }, []);

  const handleAddClick = () => {
    const val = inputRef.current.value.trim();
    if (val === '') return;
    const taskId = 'local-' + Date.now();
    setTasks(prev => [...prev, { id: taskId, title: val, completed: false }]);
    inputRef.current.value = '';
  };

  const toggleComplete = id => {
    setTasks(prev =>
      prev.map(t =>
        t.id === id ? { ...t, completed: !t.completed } : t
      )
    );
  };

  const deleteTask = id => {
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const clearCompleted = () => {
    setTasks(prev => prev.filter(t => !t.completed));
  };

  const toggleShowCompleted = () => {
    setShowingCompletedOnly(!showingCompletedOnly);
  };

  return (
    <div>
      <input id="task-input" type="text" ref={inputRef} />
      <button id="add-btn" onClick={handleAddClick}>
        Add
      </button>
      <button id="toggle-completed" onClick={toggleShowCompleted}>
        {showingCompletedOnly ? 'Show all' : 'Show completed only'}
      </button>
      <button id="clear-completed" onClick={clearCompleted}>
        Clear Completed
      </button>
      <ul id="task-list">
        {filteredTasks.map(task => (
          <li
            key={task.id}
            className={task.completed ? 'completed' : ''}
            data-task-id={task.id}
          >
            <input
              type="checkbox"
              className="task-checkbox"
              checked={task.completed}
              onChange={() => toggleComplete(task.id)}
            />
            <span className="task-text">{task.title}</span>
            <button className="delete-btn" onClick={() => deleteTask(task.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      <div id="stats">{statsText}</div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);