import React, { useState, useEffect } from 'react';

function TaskInput({ value, onChange, onAddClick }) {
  return (
    <>
      <input id="task-input" type="text" value={value} onChange={onChange} />
      <button id="add-btn" onClick={onAddClick}>Add Task</button>
    </>
  );
}

function TaskItem({ task, onDelete, onToggle }) {
  return (
    <li className={task.completed ? 'completed' : ''}>
      <input
        type="checkbox"
        className="task-checkbox"
        checked={task.completed}
        onChange={() => onToggle(task.id)}
      />
      <span className="task-text">{task.title}</span>
      <button className="delete-btn" onClick={() => onDelete(task.id)}>
        Delete
      </button>
    </li>
  );
}

function TaskList({ tasks, onDelete, onToggle }) {
  return (
    <ul id="task-list">
      {tasks.map(task => (
        <TaskItem
          key={task.id}
          task={task}
          onDelete={onDelete}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

function Stats({ tasks }) {
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const remaining = total - completed;
  return (
    <div id="stats">
      Total: {total} | Completed: {completed} | Remaining: {remaining}
    </div>
  );
}

function Controls({ showCompletedOnly, onToggleShow, onClearCompleted }) {
  return (
    <>
      <button id="toggle-completed" onClick={onToggleShow}>
        {showCompletedOnly ? 'Show all' : 'Show completed only'}
      </button>
      <button id="clear-completed" onClick={onClearCompleted}>
        Clear Completed
      </button>
    </>
  );
}

function App() {
  const [tasks, setTasks] = useState([]);
  const [showCompletedOnly, setShowCompletedOnly] = useState(false);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    fetch('https://jsonplaceholder.typicode.com/todos?_limit=3')
      .then(res => res.json())
      .then(data => {
        const initialTasks = data.map(item => ({
          id: item.id,
          title: item.title,
          completed: item.completed
        }));
        setTasks(initialTasks);
      })
      .catch(console.error);
  }, []);

  const handleAdd = () => {
    const val = inputValue.trim();
    if (val === '') return;
    const newTask = {
      id: 'local-' + Date.now(),
      title: val,
      completed: false
    };
    setTasks(prev => [...prev, newTask]);
    setInputValue('');
  };

  const handleDelete = id => {
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const handleToggle = id => {
    setTasks(prev =>
      prev.map(t =>
        t.id === id ? { ...t, completed: !t.completed } : t
      )
    );
  };

  const handleToggleShow = () => {
    setShowCompletedOnly(prev => !prev);
  };

  const handleClearCompleted = () => {
    setTasks(prev => prev.filter(t => !t.completed));
  };

  const visibleTasks = showCompletedOnly
    ? tasks.filter(t => t.completed)
    : tasks;

  return (
    <div>
      <TaskInput
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        onAddClick={handleAdd}
      />
      <TaskList
        tasks={visibleTasks}
        onDelete={handleDelete}
        onToggle={handleToggle}
      />
      <Stats tasks={tasks} />
      <Controls
        showCompletedOnly={showCompletedOnly}
        onToggleShow={handleToggleShow}
        onClearCompleted={handleClearCompleted}
      />
    </div>
  );
}

export default App;