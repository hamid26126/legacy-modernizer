import React, { useState, useEffect } from 'react';

function TaskBoard() {
  const [tasks, setTasks] = useState([]);
  const [showingCompletedOnly, setShowingCompletedOnly] = useState(false);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    fetch('https://jsonplaceholder.typicode.com/todos?_limit=3')
      .then(res => res.json())
      .then(data => {
        const mapped = data.map(item => ({
          id: String(item.id),
          title: item.title,
          completed: item.completed
        }));
        setTasks(mapped);
      });
  }, []);

  const handleAdd = () => {
    const trimmed = inputValue.trim();
    if (trimmed === '') return;
    const newTask = {
      id: 'local-' + Date.now(),
      title: trimmed,
      completed: false
    };
    setTasks(prev => [...prev, newTask]);
    setInputValue('');
  };

  const handleDelete = (id) => {
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const handleToggle = (id) => {
    setTasks(prev =>
      prev.map(t =>
        t.id === id ? { ...t, completed: !t.completed } : t
      )
    );
  };

  const handleToggleCompletedOnly = () => {
    setShowingCompletedOnly(prev => !prev);
  };

  const handleClearCompleted = () => {
    setTasks(prev => prev.filter(t => !t.completed));
  };

  const visibleTasks = showingCompletedOnly
    ? tasks.filter(t => t.completed)
    : tasks;
  const total = visibleTasks.length;
  const completed = visibleTasks.filter(t => t.completed).length;
  const remaining = total - completed;

  return (
    <div>
      <input
        id="task-input"
        type="text"
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        placeholder="Enter a task"
      />
      <button id="add-btn" onClick={handleAdd}>
        Add Task
      </button>
      <button id="toggle-completed" onClick={handleToggleCompletedOnly}>
        {showingCompletedOnly ? 'Show all' : 'Show completed only'}
      </button>
      <button id="clear-completed" onClick={handleClearCompleted}>
        Clear Completed
      </button>
      <div id="stats">
        Total: {total} | Completed: {completed} | Remaining: {remaining}
      </div>
      <ul id="task-list">
        {visibleTasks.map(task => (
          <li
            key={task.id}
            className={task.completed ? 'completed' : ''}
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
    </div>
  );
}

export default TaskBoard;