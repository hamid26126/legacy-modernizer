import React, { useState, useEffect, useRef } from 'react';

function App() {
  const [tasks, setTasks] = useState([]);
  const [showingCompletedOnly, setShowingCompletedOnly] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    fetch('https://jsonplaceholder.typicode.com/todos?_limit=3')
      .then(response => response.json())
      .then(data => {
        setTasks(
          data.map(item => ({
            id: item.id,
            title: item.title,
            completed: item.completed
          }))
        );
      });
  }, []);

  const onAddClick = () => {
    const val = inputRef.current?.value.trim() ?? '';
    if (val === '') return;
    const newTask = {
      id: 'local-' + Date.now(),
      title: val,
      completed: false
    };
    setTasks(prev => [...prev, newTask]);
    inputRef.current.value = '';
  };

  const onDelete = id => {
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const onToggleComplete = id => {
    setTasks(prev =>
      prev.map(t =>
        t.id === id ? { ...t, completed: !t.completed } : t
      )
    );
  };

  const onFilterToggle = () => {
    setShowingCompletedOnly(prev => !prev);
  };

  const onClearCompleted = () => {
    setTasks(prev => prev.filter(t => !t.completed));
  };

  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const remaining = total - completed;

  return (
    <div>
      <input id="task-input" type="text" ref={inputRef} />
      <button id="add-btn" onClick={onAddClick}>Add</button>

      <button id="toggle-completed" onClick={onFilterToggle}>
        {showingCompletedOnly ? 'Show all' : 'Show completed only'}
      </button>

      <button id="clear-completed" onClick={onClearCompleted}>
        Clear Completed
      </button>

      <div id="stats">
        Total: {total} | Completed: {completed} | Remaining: {remaining}
      </div>

      <ul id="task-list">
        {tasks
          .filter(task => !showingCompletedOnly || task.completed)
          .map(task => (
            <li
              key={task.id}
              data-task-id={String(task.id)}
              className={task.completed ? 'completed' : ''}
            >
              <input
                type="checkbox"
                className="task-checkbox"
                checked={task.completed}
                onChange={() => onToggleComplete(task.id)}
              />
              <span className="task-text">{task.title}</span>
              <button className="delete-btn" onClick={() => onDelete(task.id)}>
                Delete
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

export default App;