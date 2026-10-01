import React, { useState, useEffect } from 'react';

function App() {
  const [tasks, setTasks] = useState([]);
  const [showingCompletedOnly, setShowingCompletedOnly] = useState(false);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    fetch('https://jsonplaceholder.typicode.com/todos?_limit=3')
      .then(response => response.json())
      .then(data => {
        setTasks(data.map(item => ({
          id: item.id,
          title: item.title,
          completed: item.completed
        })));
      })
      .catch(console.error);
  }, []);

  const handleAdd = () => {
    const val = inputValue.trim();
    if (val === '') return;
    const taskId = 'local-' + Date.now();
    setTasks([...tasks, { id: taskId, title: val, completed: false }]);
    setInputValue('');
  };

  const handleDelete = (id) => {
    setTasks(tasks.filter(t => t.id !== id));
  };

  const handleToggle = (id) => {
    setTasks(tasks.map(t =>
      t.id === id ? { ...t, completed: !t.completed } : t
    ));
  };

  const handleToggleCompleted = () => {
    setShowingCompletedOnly(!showingCompletedOnly);
  };

  const handleClearCompleted = () => {
    setTasks(tasks.filter(t => !t.completed));
  };

  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const remaining = total - completed;

  const displayedTasks = showingCompletedOnly
    ? tasks.filter(t => t.completed)
    : tasks;

  return (
    <>
      <input id="task-input" value={inputValue} onChange={e => setInputValue(e.target.value)} />
      <button id="add-btn" onClick={handleAdd}>Add</button>
      <button id="toggle-completed" onClick={handleToggleCompleted}>
        {showingCompletedOnly ? 'Show all' : 'Show completed only'}
      </button>
      <button id="clear-completed" onClick={handleClearCompleted}>Clear Completed</button>
      <div id="stats">
        Total: {total} | Completed: {completed} | Remaining: {remaining}
      </div>
      <ul id="task-list">
        {displayedTasks.map(task => (
          <li
            key={task.id}
            id={`task-${task.id}`}
            className={task.completed ? 'completed' : ''}
            data-task-id={task.id}
          >
            <input
              type="checkbox"
              className="task-checkbox"
              checked={task.completed}
              onChange={() => handleToggle(task.id)}
            />
            <span className="task-text">{task.title}</span>
            <button className="delete-btn" onClick={() => handleDelete(task.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export default App;